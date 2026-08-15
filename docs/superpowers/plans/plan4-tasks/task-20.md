### Task 20: `packages/server/src/race.ts` and `packages/server/src/content.ts`

`race.ts` is the server's whole relationship with a running race: it constructs
the one `ShadowLoop` a room ever gets, it hands that loop ticks, and it observes
the promotion the loop made. `content.ts` is the four static values the shadow
needs to step in lockstep with the host — and the module whose one subtle rule,
if broken, turns every room in the process into a leader.

**Four things bind this task:**

- **The shadow owns host-loss detection and counts elapsed milliseconds.** There
  is deliberately no second detector. `race.ts` has no `maybePromote`, no
  `noteHostSnapshot` and no `liveness.hostLost`; F-P4-22 ruled that duplicate out
  precisely because two timers disagree under load — and they disagree *exactly*
  when the disagreement matters, because a tick counter stalls when the
  accumulator clamps.
- **`stepRace` hands `advanceAccumulator` an elapsed DELTA and `tick` an ABSOLUTE
  `nowMs`, and every tick in one burst gets the same `nowMs`.** That is correct
  rather than sloppy: those ticks are catching up *to* that instant, not
  advancing past it, and a truthful timestamp is the whole reason a clamped burst
  still promotes on time.
- **`ContentProvider.contextFor` allocates a new `SimContext` on every call.**
  `ShadowLoop` does not copy its `ctx` — `promote()` writes `isLeader` into the
  **caller's** object — so a memoised `contextFor` would let one room's promotion
  turn every other room in the process into a leader, each one rolling items and
  emitting events for a race whose host is perfectly healthy. The `track` and
  `query` *inside* the context are shared and must be: they are read-only, and
  `loadTrack` memoises the arc table so a sixty-fourth room does not rebuild it.
- **A shadow is never introduced mid-race.** `startRace` refuses a room that
  already has one. A shadow that joined a running race would settle ~12 ticks
  behind permanently, and a promotion from it would broadcast snapshots with tick
  numbers *below* the last the host sent — the client's filter discards about
  four snapshots and the first accepted one rewinds the guest's world by ~12
  ticks of travel. That is spec §5's "no kart teleports backward".

**Execution order.** Depends on Task 18 (`lobby.ts`, `roomtransport.ts`) and on
Task 22's Steps 1–4 (`log.ts`, for `LogSink`). Must land **before** Tasks 19 and
19b, which import `startRace`, `stepRace`, `pollRace`, `endRace` and
`defaultContentProvider`.

**Files:**
- Create: `packages/server/src/race.ts`
- Create: `packages/server/src/content.ts`
- Test: `packages/server/test/race.test.ts`
- Test: `packages/server/test/content.test.ts`

**Interfaces:**

- Consumes — `@tapkart/sim` [Plan 1, shipped]:
  ```ts
  export const MAX_KARTS = 8
  export const TICK_HZ = 60
  export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning; characters: CharacterStats[]; isLeader: boolean }
  /** Every seat is created `isBot: true, connected: false`. Nothing in `sim`
   *  knows which seats are human. */
  export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
  ```

- Consumes — `@tapkart/content` [Plan 3 §3a, R46]:
  ```ts
  export const TUNING: Readonly<Tuning>
  export const CHARACTERS: readonly CharacterStats[]
  export interface TrackManifestEntry { id: string; name: string }
  export const TRACK_MANIFEST: readonly TrackManifestEntry[]      // six ids, menu order
  export interface LoadedTrack { track: Track; query: TrackQuery; theme: TrackTheme }
  export function loadTrack(id: string): LoadedTrack              // total over TRACK_MANIFEST ids, MEMOISED
  ```

- Consumes — `@tapkart/net` [contract §2.2, §2.5, §4.7]:
  ```ts
  export const HOST_TIMEOUT_MS = 1500
  export const SNAPSHOT_PERIOD_TICKS = 3
  export class ShadowLoop {
    constructor(ctx: SimContext, state: SimState, t: Transport)
    /** `nowMs` is the scheduler's wall clock, injected -- the loop reads no
     *  clock. It is the host-loss timer's only time source. */
    tick(nowMs: number): void
    promote(tick: number): void
    /** -1 until promoted (§2.10 G3). */
    promotionTick(): number
  }
  export const MAX_CATCHUP_TICKS = 5
  export const TICK_MS = 1000 / TICK_HZ
  export interface TickAccumulator { residualMs: number }
  export function makeTickAccumulator(): TickAccumulator
  /** Takes ELAPSED milliseconds, not a timestamp. Across a clamp the excess is
   *  DISCARDED, not banked. */
  export function advanceAccumulator(acc: TickAccumulator, elapsedMs: number): number
  export function withPeerAuthority(inner: Transport, authority: PeerAuthority): Transport
  export function peerAuthorityDropsOf(t: Transport): PeerAuthorityDrops
  export interface PeerAuthorityDrops { wrongSeat: number; notAuthority: number; malformed: number }
  export interface LoopbackOptions { latencyMs: number; jitterMs: number; lossRate: number; seed: number }
  export function makeLoopbackPair(opts: LoopbackOptions): { a: Transport; b: Transport; pump(nowMs: number): void }
  export class AuthorityLoop {
    constructor(ctx: SimContext, state: SimState, t: Transport)
    state(): SimState
    tick(): void
  }
  export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number }
  ```

- Consumes — the server's own:
  ```ts
  // src/types.ts   (§5.1)  RoomRecord, RaceRuntime  -- quoted in Task 18
  // src/lobby.ts   (§5.5, Task 18)
  export function seatMapOf(room: RoomRecord): PeerAuthority
  // src/roomtransport.ts (§5.6, Task 18)
  export interface RoomTransport extends Transport {
    deliver(peerId: string, channel: ChannelName, payload: Uint8Array): void
    notePeerGone(peerId: string): void
  }
  // src/log.ts     (§5.11, Task 22)
  export interface LogSink { write(ev: LogEvent, nowMs: number): void }
  ```

- Produces — `src/race.ts`, the five §5.8 pins:
  ```ts
  export interface StartRaceOptions {
    room: RoomRecord
    /** MUST be a FRESH SimContext with isLeader false -- see §7. */
    ctx: SimContext
    seed: number
    characterIdx: number[]
    humanMask: number
    transport: RoomTransport
    nowMs: number
  }
  export function startRace(opts: StartRaceOptions): RaceRuntime
  export function stepRace(run: RaceRuntime, nowMs: number): number
  export function pollRace(run: RaceRuntime, log: LogSink, nowMs: number): boolean
  export function endRace(run: RaceRuntime): void
  ```

- Produces — `src/content.ts`, the three §5.9 pins:
  ```ts
  export interface ContentProvider {
    track(id: string): Track | null
    contextFor(trackId: string): SimContext | null
    trackIds(): readonly string[]
  }
  export function makeContentProvider(): ContentProvider
  export const defaultContentProvider: ContentProvider
  ```

**Two decisions this task makes:**

1. **`pollRace` writes `code: ''` and the caller stamps the room code.** A
   `RaceRuntime` carries no room code — §5.1 pins its eight fields and none of
   them is one — so `pollRace` cannot know it. `RoomHub` passes a room-scoped
   `LogSink` that fills an empty `code` (Task 19b), which keeps §5.1 unchanged
   and keeps this function a function of its arguments.
2. **`startRace` throws on a leader context and on a room that already races.**
   These are the only two throws in the module. Both are programmer errors on
   data this process produced — the same class as `writeString`'s encode-side
   throw — and both are unreachable in production because `contextFor` always
   returns `isLeader: false` and `RoomHub` guards the second. They exist because
   §7.1's failure is *silent and process-wide*: it took a 3 cm divergence
   measured at 40 ticks to find the last one.

---

- [ ] **Step 1: Write the failing test for `content.ts`**

Create `packages/server/test/content.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CHARACTERS, TRACK_MANIFEST, TUNING, loadTrack } from '@tapkart/content'
import { defaultContentProvider, makeContentProvider } from '../src/content'

describe('ContentProvider.trackIds / track', () => {
  it('is exactly the shipped manifest, in menu order', () => {
    const p = makeContentProvider()
    expect(p.trackIds()).toEqual(TRACK_MANIFEST.map((e) => e.id))
    expect(p.trackIds().length).toBeGreaterThan(0)          // the floor
  })

  it('returns a real Track for every manifest id and null for anything else', () => {
    const p = makeContentProvider()
    for (const entry of TRACK_MANIFEST) {
      const track = p.track(entry.id)
      expect(track).not.toBeNull()
      expect(track!.id).toBe(entry.id)
      expect(track!.startPositions.length).toBeGreaterThan(0)
    }
    expect(p.track('not-a-track')).toBeNull()
    expect(p.track('')).toBeNull()
  })
})

describe('ContentProvider.contextFor — §7.1, the rule whose violation is silent', () => {
  const first = TRACK_MANIFEST[0].id

  it('returns a DISTINCT object every call, with isLeader false', () => {
    const p = makeContentProvider()
    const a = p.contextFor(first)
    const b = p.contextFor(first)

    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
    expect(a!.isLeader).toBe(false)
    expect(b!.isLeader).toBe(false)
  })

  it('does not let one context\'s promotion reach another', () => {
    // This is the whole rule. ShadowLoop.promote() writes `ctx.isLeader = true`
    // into the object it was HANDED -- it does not copy, unlike AuthorityLoop
    // and ClientLoop -- so a memoised contextFor would turn every room in the
    // process into a leader the moment any one room lost its host.
    const p = makeContentProvider()
    const a = p.contextFor(first)!
    const b = p.contextFor(first)!

    a.isLeader = true

    expect(b.isLeader).toBe(false)
    expect(p.contextFor(first)!.isLeader).toBe(false)
  })

  it('SHARES the track and the query inside it, which is the point', () => {
    // loadTrack memoises so the arc table is built once per track per process.
    // Sharing read-only geometry is right; sharing the mutable wrapper is not.
    const p = makeContentProvider()
    const a = p.contextFor(first)!
    const b = p.contextFor(first)!

    expect(a.track).toBe(b.track)
    expect(a.query).toBe(b.query)
    expect(a.track).toBe(loadTrack(first).track)
  })

  it('carries the shipped tuning and characters', () => {
    const p = makeContentProvider()
    const ctx = p.contextFor(first)!
    expect(ctx.tuning.maxSpeed).toBe(TUNING.maxSpeed)
    expect(ctx.characters).toHaveLength(CHARACTERS.length)
    expect(ctx.characters[0].id).toBe(CHARACTERS[0].id)
    // A mutable copy, so nothing can write through it into the shared array.
    expect(ctx.characters).not.toBe(CHARACTERS as unknown as typeof ctx.characters)
  })

  it('returns null for an unknown track', () => {
    expect(makeContentProvider().contextFor('not-a-track')).toBeNull()
  })
})

describe('defaultContentProvider', () => {
  it('is a ContentProvider over the same shipped data', () => {
    expect(defaultContentProvider.trackIds()).toEqual(TRACK_MANIFEST.map((e) => e.id))
    const ctx = defaultContentProvider.contextFor(TRACK_MANIFEST[0].id)
    expect(ctx).not.toBeNull()
    expect(ctx!.isLeader).toBe(false)
    expect(defaultContentProvider.contextFor(TRACK_MANIFEST[0].id)).not.toBe(ctx)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/content.test.ts`

Expected: FAIL at collection with
`Failed to resolve import "../src/content" from "packages/server/test/content.test.ts". Does the file exist?`

- [ ] **Step 3: Write `packages/server/src/content.ts`**

```ts
// PURE. Over @tapkart/content's TRACK_MANIFEST, loadTrack, TUNING and
// CHARACTERS. No filesystem, no injection, no parsing at runtime: R46 makes the
// content a static import, so a malformed track is a build failure rather than a
// startup surprise, and the server's track bytes and the browser's are now the
// same module.
import type { SimContext, Track } from '@tapkart/sim'
import { CHARACTERS, TRACK_MANIFEST, TUNING, loadTrack } from '@tapkart/content'

export interface ContentProvider {
  track(id: string): Track | null
  /**
   * A FRESH SimContext for one race, allocated per call, with isLeader FALSE.
   * Never memoised and never shared between rooms -- ShadowLoop.promote() writes
   * `ctx.isLeader = true` into the object it was handed, so a shared context
   * would let one room's promotion turn every other room in the process into a
   * leader. The `track` and `query` INSIDE it are shared, and that is fine: both
   * are read-only and `loadTrack` memoises the arc table for exactly that reason.
   */
  contextFor(trackId: string): SimContext | null
  trackIds(): readonly string[]
}

export function makeContentProvider(): ContentProvider {
  const ids: readonly string[] = TRACK_MANIFEST.map((entry) => entry.id)
  const known = new Set<string>(ids)

  return {
    track(id: string): Track | null {
      return known.has(id) ? loadTrack(id).track : null
    },

    contextFor(trackId: string): SimContext | null {
      if (!known.has(trackId)) return null
      const loaded = loadTrack(trackId)
      return {
        track: loaded.track,
        query: loaded.query,
        tuning: TUNING,
        // `readonly CharacterStats[]` is not assignable to `CharacterStats[]`,
        // and a copy also means nothing can write through this context into the
        // array every other room reads.
        characters: CHARACTERS.slice(),
        isLeader: false,
      }
    },

    trackIds(): readonly string[] {
      return ids
    },
  }
}

/** The one instance `main.ts` wires in. Tests construct their own over sim's
 *  fixture track rather than the six shipped ones. */
export const defaultContentProvider: ContentProvider = makeContentProvider()
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run packages/server/test/content.test.ts`
Expected: 8 passing.

- [ ] **Step 5: Write the failing test for `race.ts`**

Create `packages/server/test/race.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { SimContext } from '@tapkart/sim'
import { MAX_KARTS, createState } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import type { ShadowLoop, Transport } from '@tapkart/net'
import {
  AuthorityLoop, HOST_TIMEOUT_MS, MAX_CATCHUP_TICKS, TICK_MS, advanceAccumulator,
  createLiveness, makeLoopbackPair, makeTickAccumulator, peerAuthorityDropsOf,
} from '@tapkart/net'
import type { PeerId, PeerRecord, RaceRuntime, RoomRecord } from '../src/types'
import type { RoomTransport } from '../src/roomtransport'
import { endRace, pollRace, startRace, stepRace } from '../src/race'
import { makeMemoryLogSink } from '../src/log'
// sim's own fixture track, by relative path (§2.11). This task deliberately does
// NOT use `packages/server/test/fixtures/server-fixtures.ts`: that file is Task
// 19b's, and Task 19b needs `startRace` from this one. Three lines here break a
// cycle that would otherwise force one of the two tasks to stub the other.
import { makeContext, makeOvalTrack } from '../../sim/test/fixtures/track-fixtures'

/** FRESH per call, isLeader FALSE -- §7.1. */
function makeServerContext(): SimContext {
  return makeContext(makeOvalTrack(), false)
}

function makeRoom(hostPeerId: string | null): RoomRecord {
  const room: RoomRecord = {
    code: 'ABCDE', createdAtMs: 0, lastActivityMs: 0, phase: 'racing',
    hostPeerId, hostPlayerId: 0, trackId: 'oval', lobbyVersion: 1, raceSeed: 0,
    peers: new Map<PeerId, PeerRecord>(), slotsInUse: new Set<number>(),
    seats: new Array<PeerId | null>(MAX_KARTS).fill(null),
    rtcFailures: 0, race: null,
  }
  if (hostPeerId !== null) {
    const host: PeerRecord = {
      peerId: hostPeerId, slot: 1, playerId: 0, token: '', role: 'host', name: 'host',
      characterIdx: 0, ready: true, relay: false, connected: true,
      joinedAtMs: 0, lastSeenMs: 0, liveness: createLiveness(0),
    }
    room.peers.set(hostPeerId, host)
    room.seats[0] = hostPeerId
  }
  return room
}

/** A silent transport: it accepts everything and delivers nothing. Enough for
 *  the accumulator tests, which never send a byte. */
function nullTransport(): RoomTransport {
  return {
    send: () => { /* nothing listens */ },
    broadcast: () => { /* nothing listens */ },
    onMessage: () => { /* nothing arrives */ },
    onPeerLost: () => { /* nothing is lost */ },
    peers: () => [],
    close: () => { /* nothing to close */ },
    deliver: () => { /* the hub is not in this test */ },
    notePeerGone: () => { /* the hub is not in this test */ },
  }
}

/**
 * The loopback pair IS the wire in the promotion test, so `deliver` and
 * `notePeerGone` -- the hub's inbound seam -- are never reached. They THROW
 * rather than no-op: a silent no-op would let a future edit start depending on
 * them and drop every datagram without a symptom.
 */
function asRoomTransport(inner: Transport): RoomTransport {
  return {
    send: (c: ChannelName, p: string, d: Uint8Array) => { inner.send(c, p, d) },
    broadcast: (c: ChannelName, d: Uint8Array) => { inner.broadcast(c, d) },
    onMessage: (cb) => { inner.onMessage(cb) },
    onPeerLost: (cb) => { inner.onPeerLost(cb) },
    peers: () => inner.peers(),
    close: () => { inner.close() },
    deliver: () => { throw new Error('this harness delivers through the loopback pair') },
    notePeerGone: () => { throw new Error('this harness has no hub; peer loss rides the loopback pair') },
  }
}

function startedRace(transport: RoomTransport, nowMs = 0): { run: RaceRuntime; room: RoomRecord } {
  const room = makeRoom('host')
  const run = startRace({
    room, ctx: makeServerContext(), seed: 1234,
    characterIdx: new Array<number>(MAX_KARTS).fill(0),
    humanMask: 0b1, transport, nowMs,
  })
  room.race = run
  return { run, room }
}

describe('startRace', () => {
  it('builds the shadow\'s state and applies humanMask to isBot/connected', () => {
    const { run } = startedRace(nullTransport())

    // createState makes EVERY seat isBot: true, connected: false. The mask is
    // the only thing that can say otherwise, and without it the host, the shadow
    // and every client run bot AI on different karts.
    expect(run.state.karts[0].isBot).toBe(false)
    expect(run.state.karts[0].connected).toBe(true)
    for (let i = 1; i < MAX_KARTS; i++) {
      expect(run.state.karts[i].isBot).toBe(true)
      expect(run.state.karts[i].connected).toBe(false)
    }
    expect(run.state.tick).toBe(0)
    expect(run.state.phase).toBe('countdown')
    expect(run.state.raceSeed).toBe(1234)
    expect(run.acc.residualMs).toBe(0)
    expect(run.lastPollMs).toBe(0)
    expect(run.startedAtMs).toBe(0)
    expect(run.shadow.promotionTick()).toBe(-1)
  })

  it('refuses a context that is already a leader', () => {
    const ctx: SimContext = makeServerContext()
    ctx.isLeader = true
    expect(() => startRace({
      room: makeRoom('host'), ctx, seed: 1, characterIdx: new Array<number>(MAX_KARTS).fill(0),
      humanMask: 1, transport: nullTransport(), nowMs: 0,
    })).toThrow(/isLeader/)
  })

  it('refuses to put a second shadow on a live race', () => {
    const { run, room } = startedRace(nullTransport())
    expect(room.race).toBe(run)                      // the floor
    expect(() => startRace({
      room, ctx: makeServerContext(), seed: 2,
      characterIdx: new Array<number>(MAX_KARTS).fill(0),
      humanMask: 1, transport: nullTransport(), nowMs: 100,
    })).toThrow(/already/)
  })

  it('routes the shadow through withPeerAuthority', () => {
    const { run } = startedRace(nullTransport())
    // peerAuthorityDropsOf THROWS for a transport the decorator did not produce,
    // so this call succeeding is the assertion.
    expect(peerAuthorityDropsOf(run.transport)).toEqual({ wrongSeat: 0, notAuthority: 0, malformed: 0 })
  })
})

describe('stepRace', () => {
  /** Replaces the loop with a recorder. stepRace calls exactly one method. */
  function recorder(run: RaceRuntime): number[] {
    const calls: number[] = []
    run.shadow = {
      tick: (nowMs: number) => { calls.push(nowMs) },
      promotionTick: () => -1,
    } as unknown as ShadowLoop
    return calls
  }

  it('turns one tick interval into exactly one tick', () => {
    const { run } = startedRace(nullTransport())
    const calls = recorder(run)

    expect(stepRace(run, TICK_MS)).toBe(1)
    expect(calls).toEqual([TICK_MS])
    expect(run.lastPollMs).toBe(TICK_MS)
  })

  it('hands advanceAccumulator a DELTA, not a timestamp', () => {
    const { run } = startedRace(nullTransport())
    recorder(run)

    // Two calls, one tick interval apart. If the accumulator were handed the
    // absolute time, the second call would see 33 ms of backlog and run two.
    expect(stepRace(run, TICK_MS)).toBe(1)
    expect(stepRace(run, TICK_MS * 2)).toBe(1)
    expect(run.lastPollMs).toBe(TICK_MS * 2)
  })

  it('clamps a stall at MAX_CATCHUP_TICKS, discards the excess, and gives every tick the SAME absolute nowMs', () => {
    const { run } = startedRace(nullTransport())
    const calls = recorder(run)

    expect(stepRace(run, 1000)).toBe(MAX_CATCHUP_TICKS)
    // Every tick in one burst is catching up TO that instant, not advancing past
    // it -- and a truthful timestamp is what makes a clamped burst promote on
    // time, which is the whole reason the host-loss timer counts milliseconds.
    expect(calls).toEqual(new Array<number>(MAX_CATCHUP_TICKS).fill(1000))
    // Banking the excess would make the next call emit another full burst and
    // the stall would echo for as many frames as it took.
    expect(run.acc.residualMs).toBe(0)

    calls.length = 0
    expect(stepRace(run, 1000 + TICK_MS)).toBe(1)
    expect(calls).toEqual([1000 + TICK_MS])
  })

  it('advances lastPollMs exactly once per call, even when no tick runs', () => {
    const { run } = startedRace(nullTransport())
    const calls = recorder(run)

    expect(stepRace(run, 8)).toBe(0)
    expect(calls).toEqual([])
    expect(run.lastPollMs).toBe(8)
    expect(stepRace(run, 16)).toBe(0)
    expect(run.lastPollMs).toBe(16)
    expect(stepRace(run, 20)).toBe(1)     // 20 ms total elapsed crosses one interval
  })
})

describe('pollRace', () => {
  it('writes exactly one promotion line, on the first pass that sees it', () => {
    const { run } = startedRace(nullTransport())
    const log = makeMemoryLogSink()

    expect(pollRace(run, log, 100)).toBe(false)
    expect(log.events()).toEqual([])

    run.shadow.promote(42)
    expect(run.shadow.promotionTick()).toBe(42)       // the floor

    expect(pollRace(run, log, 200)).toBe(true)
    expect(pollRace(run, log, 208)).toBe(false)
    expect(pollRace(run, log, 216)).toBe(false)

    const promotions = log.events().filter((e) => e.kind === 'promotion')
    expect(promotions).toHaveLength(1)
    expect(promotions[0]).toEqual({
      kind: 'promotion',
      // A RaceRuntime carries no room code -- §5.1 pins its eight fields -- so
      // the caller stamps it. RoomHub passes a room-scoped LogSink.
      code: '',
      tick: 42,
      eventSeq: run.state.nextEventSeq,
    })
  })
})

describe('endRace', () => {
  it('closes the room transport it was given', () => {
    let closed = 0
    const t = nullTransport()
    const run = startRace({
      room: makeRoom('host'), ctx: makeServerContext(), seed: 5,
      characterIdx: new Array<number>(MAX_KARTS).fill(0), humanMask: 1,
      transport: { ...t, close: () => { closed += 1 } }, nowMs: 0,
    })
    endRace(run)
    expect(closed).toBe(1)
  })
})

describe('spec §8 — the promotion test, over a lossy link', () => {
  it('promotes at 1500 ms of silence and not before, and nothing rewinds', () => {
    const lb = makeLoopbackPair({ latencyMs: 150, jitterMs: 50, lossRate: 0.05, seed: 20260814 })

    // Learn the peer id THIS loopback uses for the host end, without advancing
    // the host by a single tick: a shadow introduced mid-race would settle
    // permanently behind, and its promotion would broadcast ticks below the last
    // the host sent.
    let hostPeerId = ''
    lb.b.onMessage((peerId) => { if (hostPeerId === '') hostPeerId = peerId })
    let probeAt = 0
    while (hostPeerId === '' && probeAt < 2000) {
      lb.a.broadcast('reliable', new Uint8Array([0xff, 0xff]))
      probeAt += 16
      lb.pump(probeAt)
    }
    expect(hostPeerId).not.toBe('')

    const room = makeRoom(hostPeerId)
    const characterIdx = [0, 1, 2, 3, 4, 5, 6, 7]
    const humanMask = 0b1                       // seat 0 is the host; seven bots race

    const hostCtx = makeServerContext()
    hostCtx.isLeader = true
    const hostState = createState(hostCtx, 987_654, characterIdx)
    for (let i = 0; i < MAX_KARTS; i++) {
      const human = ((humanMask >>> i) & 1) === 1
      hostState.karts[i].isBot = !human
      hostState.karts[i].connected = human
    }
    const host = new AuthorityLoop(hostCtx, hostState, lb.a)

    const start = probeAt
    const run = startRace({
      room, ctx: makeServerContext(), seed: 987_654, characterIdx, humanMask,
      transport: asRoomTransport(lb.b), nowMs: start,
    })
    room.race = run
    const log = makeMemoryLogSink()

    const hostAcc = makeTickAccumulator()
    let hostLast = start
    let hostAlive = true
    const laps = new Array<number>(MAX_KARTS).fill(0)
    const gridX = run.state.karts[1].position.x
    let maxEntityCount = 0
    let lastSeq = 0

    const advance = (from: number, until: number): number => {
      let now = from
      for (; now <= until; now += 8) {
        lb.pump(now)
        if (hostAlive) {
          const n = advanceAccumulator(hostAcc, now - hostLast)
          hostLast = now
          for (let i = 0; i < n; i++) host.tick()
        }
        stepRace(run, now)
        pollRace(run, log, now)
        for (let i = 0; i < MAX_KARTS; i++) {
          expect(run.state.karts[i].lap.lap).toBeGreaterThanOrEqual(laps[i])
          laps[i] = run.state.karts[i].lap.lap
        }
        expect(run.state.nextEventSeq).toBeGreaterThanOrEqual(lastSeq)
        lastSeq = run.state.nextEventSeq
        if (run.state.entityCount > maxEntityCount) maxEntityCount = run.state.entityCount
      }
      return now
    }

    // 600 ticks of racing, following a host over a 150 ms / 50 ms / 5 % link.
    let now = advance(start + 8, start + 10_000)

    // Four floors. Without them every assertion after the kill would pass
    // against a shadow that never ran, never followed, and never saw a byte.
    expect(run.state.tick).toBeGreaterThan(500)
    expect(host.state().tick).toBeGreaterThan(500)
    const drops = peerAuthorityDropsOf(run.transport)
    expect(drops.notAuthority).toBe(0)
    expect(drops.wrongSeat).toBe(0)
    expect(run.state.karts[1].position.x).not.toBe(gridX)   // the karts actually moved
    expect(maxEntityCount).toBeGreaterThan(0)   // items were rolled and entities lived
    expect(run.shadow.promotionTick()).toBe(-1)

    // The host's phone backgrounds: it stops broadcasting. The socket says
    // nothing, which is exactly the case a tick counter gets wrong.
    hostAlive = false
    const silentAt = now
    const entitiesBefore = run.state.entityCount
    const seqBefore = run.state.nextEventSeq

    // Any snapshot already in flight still resets the timer, so the deadline is
    // measured from the last one the shadow TICKED with -- allow the link's
    // latency plus jitter before the "not yet" window ends.
    now = advance(now, silentAt + HOST_TIMEOUT_MS - 300)
    expect(run.shadow.promotionTick()).toBe(-1)

    now = advance(now, silentAt + HOST_TIMEOUT_MS + 400)
    const promotionTick = run.shadow.promotionTick()
    expect(promotionTick).toBeGreaterThanOrEqual(0)

    // Exactly one promotion line, and the room code is the caller's to stamp.
    expect(log.events().filter((e) => e.kind === 'promotion')).toHaveLength(1)

    // Promotion re-seats the authority; it does not reset the world. The shadow
    // has been ticking all along, which is why spec §5 says there is no rewind.
    expect(run.state.tick).toBeGreaterThan(promotionTick - 5)
    expect(run.state.entityCount).toBeGreaterThanOrEqual(Math.max(0, entitiesBefore - 2))
    expect(run.state.nextEventSeq).toBeGreaterThanOrEqual(seqBefore)
    expect(run.ctx.isLeader).toBe(true)
    expect(run.state.raceSeed).toBe(987_654)    // never written: statesEqual stays meaningful

    // ...and it keeps racing afterwards.
    const tickAtPromotion = run.state.tick
    now = advance(now, now + 1000)
    expect(run.state.tick).toBeGreaterThan(tickAtPromotion + 50)
  })
})
```

> If `maxEntityCount` is 0 on your machine, **lengthen the pre-kill run** rather
> than deleting the floor: it means the bots had not used an item yet, and an
> entity assertion over a world with no entities asserts nothing.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run packages/server/test/race.test.ts`

Expected: FAIL at collection with
`Failed to resolve import "../src/race" from "packages/server/test/race.test.ts". Does the file exist?`

- [ ] **Step 7: Write `packages/server/src/race.ts`**

```ts
// PURE. Every function takes `nowMs`; nothing here reads a clock or holds a
// timer.
//
// There is no `maybePromote`, no `noteHostSnapshot` and no `server/ticker.ts`
// (F-P4-22, F-P4-7). The shadow owns host-loss detection because the promote
// path it guards is already written, tested and mutation-checked, and a second
// detector disagrees with it exactly under load. The accumulator is
// @tapkart/net's because `server` may not import `game` and two copies of
// MAX_CATCHUP_TICKS do not stay equal -- and when they diverge the host and the
// server run the same race at two different speeds under load.
import { MAX_KARTS, createState } from '@tapkart/sim'
import type { SimContext } from '@tapkart/sim'
import { ShadowLoop, advanceAccumulator, makeTickAccumulator, withPeerAuthority } from '@tapkart/net'
import type { RaceRuntime, RoomRecord } from './types'
import type { RoomTransport } from './roomtransport'
import { seatMapOf } from './lobby'
import type { LogSink } from './log'

export interface StartRaceOptions {
  room: RoomRecord
  /** MUST be a FRESH SimContext with isLeader false -- see §7.1. */
  ctx: SimContext
  seed: number
  characterIdx: number[]
  humanMask: number
  transport: RoomTransport
  nowMs: number
}

/**
 * Builds the shadow's SimState with createState, applies humanMask to
 * isBot/connected, wraps `transport` in withPeerAuthority(seatMapOf(room)),
 * constructs the ShadowLoop and starts the accumulator.
 *
 * SOLE CONSTRUCTOR of a ShadowLoop in the entire server.
 */
export function startRace(opts: StartRaceOptions): RaceRuntime {
  if (opts.ctx.isLeader) {
    // §7.1. ShadowLoop.promote() writes isLeader into the object it is handed,
    // so a context that arrives already a leader is a context that was shared --
    // and the failure that follows is silent and process-wide.
    throw new Error('startRace: ctx.isLeader must be false; contextFor allocates a fresh SimContext per race')
  }
  if (opts.room.race !== null) {
    // A shadow introduced mid-race settles behind the host permanently, and a
    // promotion from it broadcasts tick numbers BELOW the last the host sent.
    // A late JOINER is a different thing and gets `start` then a `checkpoint`.
    throw new Error('startRace: this room already has a race; a shadow is never introduced mid-race')
  }

  const state = createState(opts.ctx, opts.seed >>> 0, opts.characterIdx)
  for (let i = 0; i < MAX_KARTS; i++) {
    // createState makes every seat `isBot: true, connected: false`. Nothing in
    // `sim` knows which seats are human, so the authority, the shadow and every
    // client must be told, identically, or their bot AI drives different karts.
    const human = ((opts.humanMask >>> i) & 1) === 1
    state.karts[i].isBot = !human
    state.karts[i].connected = human
  }

  // The one place P2-R16's authorised peer -> seat map is enforced on the
  // server. Without it any guest could forge a snapshot the shadow reconciles
  // its whole race onto, or seize any seat with one input datagram.
  const transport = withPeerAuthority(opts.transport, seatMapOf(opts.room))

  return {
    ctx: opts.ctx,
    state,
    shadow: new ShadowLoop(opts.ctx, state, transport),
    transport,
    room: opts.transport,
    acc: makeTickAccumulator(),
    lastPollMs: opts.nowMs,
    startedAtMs: opts.nowMs,
  }
}

/**
 * Called ONCE per scheduler pass per room. Returns how many ticks ran.
 * SOLE CALLER of ShadowLoop.tick().
 *
 * `advanceAccumulator` takes ELAPSED ms, so this function owns the previous
 * timestamp -- TickAccumulator has one field and no `lastNowMs`. `tick` takes
 * the ABSOLUTE `nowMs`, because the host-loss timer inside it compares against
 * `lastSnapshotAtMs`, and a truthful timestamp is what makes a clamped burst
 * promote on time. Every tick in one burst is handed the same `nowMs`, which is
 * correct: they are catching up to that instant, not advancing past it.
 */
export function stepRace(run: RaceRuntime, nowMs: number): number {
  const n = advanceAccumulator(run.acc, nowMs - run.lastPollMs)
  run.lastPollMs = nowMs
  for (let i = 0; i < n; i++) run.shadow.tick(nowMs)
  return n
}

/** One entry per RaceRuntime that has already had its promotion logged. The
 *  same WeakMap idiom `droppedDatagramsOf` uses, and for the same reason:
 *  §5.1 pins RaceRuntime's eight fields and this is not one of them. */
const logged = new WeakSet<RaceRuntime>()

/**
 * Reads `run.shadow.promotionTick()` and, on the first pass where it is no
 * longer -1, writes ONE `promotion` LogEvent. It decides nothing: promotion has
 * already happened inside the loop by the time this observes it. Returns true on
 * that first pass only.
 *
 * `code` is `''`: a RaceRuntime carries no room code. `RoomHub` passes a
 * room-scoped LogSink that stamps it.
 */
export function pollRace(run: RaceRuntime, log: LogSink, nowMs: number): boolean {
  const tick = run.shadow.promotionTick()
  if (tick < 0) return false
  if (logged.has(run)) return false
  logged.add(run)
  log.write({ kind: 'promotion', code: '', tick, eventSeq: run.state.nextEventSeq }, nowMs)
  return true
}

/**
 * Disposes the race. The shadow holds no timer and no socket -- the scheduler is
 * the hub's and the sockets are the RoomTransport's -- so closing the transport
 * is the whole of it: listeners are dropped and nothing further is delivered.
 */
export function endRace(run: RaceRuntime): void {
  run.room.close()
}
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `npx vitest run packages/server/test/race.test.ts packages/server/test/content.test.ts`
Expected: all passing. The promotion case runs two simulations for about 12 s of
virtual time and takes a couple of seconds.

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/race.ts packages/server/src/content.ts \
        packages/server/test/race.test.ts packages/server/test/content.test.ts
git commit -m "feat(server): the race runtime and the content provider

startRace is the sole constructor of a ShadowLoop in the server. It applies
humanMask to isBot/connected -- createState makes every seat a disconnected
bot, and the mask is the only thing that can say otherwise -- and it wraps
the room transport in withPeerAuthority, which is the one place the
authorised peer->seat map is enforced server-side.

stepRace hands advanceAccumulator an elapsed DELTA and ShadowLoop.tick the
ABSOLUTE nowMs, and every tick in one burst gets the same one. A clamped
burst therefore still promotes on time, which is the whole reason F-P4-22
made the host-loss counter milliseconds instead of ticks. There is no second
detector here and no maybePromote: pollRace observes a promotion that has
already happened and writes one line.

contextFor allocates a NEW SimContext per race and shares the track and
query inside it. ShadowLoop does not copy its ctx -- promote() writes
isLeader into the caller's object -- so a memoised provider would turn every
room in the process into a leader the moment one room lost its host. Two
tests pin it, and the same failure class cost this project a 3 cm
divergence hunt in Plan 1."
```
