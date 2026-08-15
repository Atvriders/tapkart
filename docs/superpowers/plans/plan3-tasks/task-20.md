### Task 20: `packages/game/src/session.ts` and `src/localinput.ts` — the composition root for one race

**Files:**
- Create: `packages/game/src/localinput.ts`
- Create: `packages/game/src/session.ts`
- Modify: `packages/game/test/fixtures/game-fixtures.ts` — **append** `makeGameContext`, `makeSessionPair` and `makeCorrectingGuest` (§9.1). Task 17 created this file and Tasks 18 and 19 appended to it; **nobody overwrites it**. `makeControlInputsFixture`, `makeSettingsFixture` and `makeLobbySlots` are already there. `makeGameContext` has no other owner in this plan, so it lands here alongside the two session fixtures that need it — add it only if it is not already present.
- Test: `packages/game/test/session.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim` (contract §2.1, §2.2 — all verified against shipped source):
  ```ts
  export type Vec3 = { x: number; y: number; z: number }
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export const COUNTDOWN_TICKS = 180
  export interface Intent { tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }
  export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning; characters: CharacterStats[]; isLeader: boolean }
  export interface SimState { tick: number; phase: RacePhase; /* …§2.1 */ karts: KartState[]; entities: EntityState[]; entityCount: number; itemBoxes: ItemBoxState[]; finishedOrder: number[] }
  export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
  export function cloneState(src: SimState, dst: SimState): void
  export function statesEqual(a: SimState, b: SimState): boolean
  export function allocStateLike(ctx: SimContext, src: SimState): SimState
  export function resetBotHold(): void          // packages/sim/src/phase.ts:41 — clears the 30 Hz module-scope bot hold
  ```
- Consumes, from `@tapkart/net` (contract §2.4 + the §2.5 gate, which Task 1 verified is open):
  ```ts
  export interface Transport { send(channel: ChannelName, peerId: string, data: Uint8Array): void
    broadcast(channel: ChannelName, data: Uint8Array): void
    onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
    onPeerLost(cb: (peerId: string) => void): void
    peers(): string[]; close(): void }
  export interface LoopbackOptions { latencyMs: number; jitterMs: number; lossRate: number; seed: number }
  export function makeLoopbackPair(opts: LoopbackOptions): { a: Transport; b: Transport; pump(nowMs: number): void }
  export class AuthorityLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void; state(): SimState }
  export class ClientLoop { constructor(ctx: SimContext, playerId: number, t: Transport); tick(localIntent: Intent): void; corrections(): number; state(): SimState }
  export interface RemoteSample { position: { x: number; y: number; z: number }; heading: number; kart: WireKart }
  export interface RemoteEntitySample { position: { x: number; y: number; z: number }; heading: number; entity: WireEntity }
  export class RemoteInterpolator {
    push(kf: RemoteKeyframe): void
    sampleKart(playerId: number, nowMs: number): RemoteSample | null
    sampleEntity(entityId: number, nowMs: number): RemoteEntitySample | null
    liveEntityIds(out: Int32Array): number
  }
  export function remoteInterpolatorOf(client: ClientLoop): RemoteInterpolator
  export function correctionDeltaOf(client: ClientLoop, outPos: Vec3): number | null
  export const LOCAL_PEER_ID = 'local'
  /** SHIPPED SIGNATURE. Two arguments, not three: the tick comes from
   *  `intent.tick`, and the decorator reads that field to apply the 30 Hz wire
   *  cadence ITSELF, dropping the odd ticks exactly as a guest's ClientLoop does.
   *  Call it once per sim tick and impose no cadence of your own — a caller that
   *  halves the rate again ships 15 Hz input, and a caller that skips the
   *  decorator to "fix" that hands the host twice a guest's steering
   *  granularity, which is the asymmetry the decorator exists to remove. */
  export interface LocalInputTransport extends Transport {
    submitLocalInput(playerId: number, intent: Intent): void
  }
  export function withLocalInput(inner: Transport): LocalInputTransport
  export function createNullTransport(): Transport
  ```
- Consumes, from `@tapkart/render` (contract §4.2):
  ```ts
  export type ViewRole = 'host' | 'guest' | 'solo'
  export interface RaceView { tick: number; alpha: number; phase: RacePhase; localPlayerId: number
    raceStartTick: number; karts: KartView[]; entities: EntityView[]; entityCount: number
    itemBoxes: ItemBoxView[]; itemBoxRespawnTicks: number; finishedOrder: number[]
    finishTick: number; countdownTicksLeft: number }
  export function createRaceView(itemBoxCount: number): RaceView
  ```
- Consumes, from `./clock` (contract §5.1, Task 16):
  ```ts
  export function renderNowMs(tick: number, alpha: number): number   // (tick + alpha) * TICK_MS
  ```
- Consumes, from `packages/game/test/fixtures/game-fixtures.ts` (§9.1):
  ```ts
  export function makeGameContext(isLeader?: boolean): SimContext
  ```
- Consumes, from `packages/sim/test/fixtures/track-fixtures.ts` by **relative path only** (§2.6):
  ```ts
  export function makeOvalTrack(overrides?: Partial<Track>): Track
  export function makeContext(track: Track, isLeader?: boolean): SimContext
  ```
- **Does not consume, but every caller that builds a `SimContext` must know** (found by the author of Tasks 1–3 while running their code, and documented in Task 2's `Produces`): `@tapkart/content` exports `CHARACTERS: readonly CharacterStats[]`, which is **not assignable** to `SimContext.characters: CharacterStats[]`. A composition root must write `characters: CHARACTERS.slice()`. `TUNING: Readonly<Tuning>` *does* assign to `tuning: Tuning`, so the asymmetry is easy to miss — arrays are the case that bites. `createSession` takes `ctx` ready-made and never builds one; the shell (Task 22) does, and writes the `.slice()`.

- Produces:
  ```ts
  // packages/game/src/localinput.ts
  export function createSoloTransport(): LocalInputTransport

  // packages/game/src/session.ts
  export interface SessionOptions {
    role: ViewRole
    ctx: SimContext             // ctx.isLeader MUST equal (role !== 'guest')
    localPlayerId: number       // 0..MAX_KARTS-1; -1 is not allowed
    seed: number
    characterIdx: number[]      // length MAX_KARTS
    transport: Transport        // NEVER null (Q15)
  }
  export interface RaceSession {
    readonly role: ViewRole
    readonly localPlayerId: number
    readonly ctx: SimContext
    readonly characterIdx: readonly number[]
    readonly raceStartTick: number
    tickOnce(localIntent: Intent): void
    state(): SimState
    prevState(): SimState
    sampleRemoteKart(playerId: number, nowMs: number): RemoteSample | null
    sampleRemoteEntity(entityId: number, nowMs: number): RemoteEntitySample | null
    remoteEntityIds(out: Int32Array): number
    corrections(): number
    correctionDelta(outPos: Vec3): number | null
    currentView(): RaceView      // the view THIS frame is built into
    prevView(): RaceView         // the view the PREVIOUS frame was built into
    swapViews(): void            // exchanges them; called AFTER audio.apply, never before
    close(): void
  }
  export function createSession(opts: SessionOptions): RaceSession
  ```
  Task 21 (`view.ts`) consumes every member above. Task 22 (`shell.ts`) consumes `createSession`, `currentView`, `prevView` and `swapViews`. Task 13 (`audio.ts`) references `prevView()`/`currentView()` as the two arguments of `buildAudioModel`.

**Two things this task decides, and why**

1. **`transport` is never `null` (Q15).** Solo composes a real transport —
   `withLocalInput(createNullTransport())` — so exactly one code path exists and
   solo, the mode that will be run thousands of times during development,
   exercises the same `AuthorityLoop` the host runs. A `null` transport creates a
   second path that is simpler in the moment and untested forever; this project
   has already paid for one of those.

2. **The session owns TWO `RaceView`s and the swap** (contract amendment, this
   task's ruling). `buildAudioModel(prev, view, out)` derives every one-shot from
   the delta between two views, and §5.11's `ViewBuilder.build` is the sole
   writer of every `RaceView` field. With one view, `prev` **is** `view`, every
   delta is empty and no `lapCross`, `impact`, `boost`, `spinOut`, `itemPickup`,
   `itemUse` or `finish` cue can ever fire in the shipped game — while the unit
   test of `buildAudioModel` stays green, because it hand-builds its two views.
   The session allocates both (it owns the race's lifetime and knows
   `ctx.track.itemBoxes.length`), and `createViewBuilder` (Task 21) primes both
   before the first frame so frame 1's delta is empty rather than "a real view
   minus a zeroed one". **`swapViews()` is called by the shell AFTER
   `audio.apply`** — cues are consumed in the frame they are raised, so swapping
   earlier drops them. The double buffer does not weaken §7.2: there are two
   objects with one writer, not one object with two.

---

- [ ] **Step 1: Write the failing test**

Create `packages/game/test/session.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Intent, SimState } from '@tapkart/sim'
import {
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  createState,
  resetBotHold,
  statesEqual,
} from '@tapkart/sim'
import { createNullTransport, withLocalInput } from '@tapkart/net'
import { renderNowMs } from '../src/clock'
import { createSoloTransport } from '../src/localinput'
import type { RaceSession } from '../src/session'
import { createSession } from '../src/session'
import { makeGameContext, makeSessionPair } from './fixtures/game-fixtures'

const CHARACTER_IDX = [3, 5, 1, 7, 2, 6, 0, 4]

function intent(steer: number, accel: number): Intent {
  return { tick: 0, steer, accel, brake: false, drift: false, useItem: false }
}

/** A solo session on the shared fixture context, with a fresh solo transport. */
function makeSolo(localPlayerId = 0): RaceSession {
  return createSession({
    role: 'solo',
    ctx: makeGameContext(true),
    localPlayerId,
    seed: 0x5EED,
    characterIdx: CHARACTER_IDX.slice(),
    transport: createSoloTransport(),
  })
}

/** Runs `ticks` ticks with one held intent and returns the local kart position. */
function driveSolo(steer: number, accel: number, ticks: number): { x: number; z: number } {
  // The 30 Hz bot hold is module-scope in packages/sim/src/phase.ts, so a
  // previous run in this process can otherwise leak one odd tick of bot intent
  // into this one. Clearing it is what makes the comparison below exact.
  resetBotHold()
  const s = makeSolo(0)
  const it = intent(steer, accel)
  for (let t = 0; t < ticks; t++) s.tickOnce(it)
  const p = s.state().karts[0].position
  const out = { x: p.x, z: p.z }
  s.close()
  return out
}

describe('createSession — construction and validation', () => {
  it('starts host and solo in countdown, with raceStartTick = COUNTDOWN_TICKS (R44)', () => {
    const solo = makeSolo()
    const host = createSession({
      role: 'host',
      ctx: makeGameContext(true),
      localPlayerId: 2,
      seed: 7,
      characterIdx: CHARACTER_IDX.slice(),
      transport: withLocalInput(createNullTransport()),
    })

    expect(solo.state().phase).toBe('countdown')
    expect(host.state().phase).toBe('countdown')
    expect(solo.raceStartTick).toBe(COUNTDOWN_TICKS)
    expect(host.raceStartTick).toBe(COUNTDOWN_TICKS)
    solo.close()
    host.close()
  })

  it('flips the local seat to a human on host and solo (§2.4 fact 2)', () => {
    const s = makeSolo(3)
    expect(s.state().karts[3].isBot).toBe(false)
    expect(s.state().karts[3].connected).toBe(true)
    // Every other seat is still bot-driven.
    expect(s.state().karts[4].isBot).toBe(true)
    expect(s.state().karts[4].connected).toBe(false)
    s.close()
  })

  it('carries characterIdx itself, because the wire does not (§2.3 fact 1)', () => {
    const pair = makeSessionPair()
    // ClientLoop builds its predicted state with an ALL-ZERO characterIdx, so
    // these two sources are provably different before the assertion is made.
    expect(pair.guest.state().karts[2].characterIdx).toBe(0)
    expect(pair.guest.characterIdx[2]).toBe(2)
    expect(pair.guest.characterIdx.length).toBe(MAX_KARTS)
    pair.host.close()
    pair.guest.close()
  })

  it('copies characterIdx, so a caller mutating its array cannot rewrite the race', () => {
    const mine = CHARACTER_IDX.slice()
    const s = createSession({
      role: 'solo',
      ctx: makeGameContext(true),
      localPlayerId: 0,
      seed: 1,
      characterIdx: mine,
      transport: createSoloTransport(),
    })
    mine[4] = 7
    expect(s.characterIdx[4]).toBe(2)
    s.close()
  })

  it('rejects a plain Transport for host and solo, instead of racing bot-driven', () => {
    expect(() =>
      createSession({
        role: 'solo',
        ctx: makeGameContext(true),
        localPlayerId: 0,
        seed: 1,
        characterIdx: CHARACTER_IDX.slice(),
        transport: createNullTransport(),
      }),
    ).toThrow(/requires a LocalInputTransport/)
  })

  it('rejects an illegal localPlayerId and a role/isLeader mismatch', () => {
    expect(() =>
      createSession({
        role: 'solo',
        ctx: makeGameContext(true),
        localPlayerId: -1,
        seed: 1,
        characterIdx: CHARACTER_IDX.slice(),
        transport: createSoloTransport(),
      }),
    ).toThrow(/localPlayerId -1/)

    expect(() =>
      createSession({
        role: 'guest',
        ctx: makeGameContext(true), // isLeader true, but a guest is a follower
        localPlayerId: 1,
        seed: 1,
        characterIdx: CHARACTER_IDX.slice(),
        transport: createNullTransport(),
      }),
    ).toThrow(/ctx\.isLeader/)
  })
})

describe('solo drives the AuthorityLoop with the player\'s own intent (Q15, R42)', () => {
  it('a full-left run and a full-right run end in different places', () => {
    // 180 frozen countdown ticks, then 120 live ticks.
    const TICKS = COUNTDOWN_TICKS + 120
    const left = driveSolo(-1, 1, TICKS)
    const right = driveSolo(1, 1, TICKS)
    const neutral = driveSolo(0, 0, TICKS)

    // Vacuity guard: the sim really ran. Without this, three identical zeroes
    // would satisfy nothing and prove nothing.
    const startX = createState(makeGameContext(true), 0x5EED, CHARACTER_IDX.slice()).karts[0]
      .position.x
    expect(Math.abs(neutral.x - startX) + Math.abs(neutral.z)).toBeGreaterThan(0)

    const sep = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
      Math.hypot(a.x - b.x, a.z - b.z)

    // THE assertion. If submitLocalInput is not wired, all three runs are the
    // same bot-driven kart on the same seed and every separation below is 0.
    expect(sep(left, right)).toBeGreaterThan(1)
    expect(sep(left, neutral)).toBeGreaterThan(1)
    expect(sep(right, neutral)).toBeGreaterThan(1)
  })

  it('createSoloTransport is a real transport with nobody on the other end', () => {
    const t = createSoloTransport()
    expect(t.peers()).toEqual([])
    expect(typeof t.submitLocalInput).toBe('function')
    // AuthorityLoop.tick() broadcasts unconditionally (§2.4 fact 3); a solo
    // transport must drop rather than queue or throw.
    expect(() => t.broadcast('unreliable', new Uint8Array(4))).not.toThrow()
    t.close()
    t.close() // idempotent
  })
})

describe('prevState — Q9\'s second SimState', () => {
  it('is a distinct object, allocated once, holding the PRE-tick state', () => {
    const s = makeSolo()
    expect(s.prevState()).not.toBe(s.state())
    expect(statesEqual(s.prevState(), s.state())).toBe(true)

    const identity: SimState[] = [s.prevState()]
    const it = intent(0.5, 1)
    for (let t = 0; t < 5; t++) {
      s.tickOnce(it)
      identity.push(s.prevState())
      // The clone happens BEFORE the loop ticks: prev trails state by exactly
      // one tick. A session that cloned afterwards would report 0 here, and
      // Q9's alpha-lerp would silently become a no-op.
      expect(s.state().tick - s.prevState().tick).toBe(1)
    }
    for (const p of identity) expect(p).toBe(identity[0])
    s.close()
  })
})

describe('the two RaceViews the audio delta needs', () => {
  it('are two distinct objects, sized from the track, and swap in place', () => {
    const s = makeSolo()
    const boxes = s.ctx.track.itemBoxes.length
    const a = s.currentView()
    const b = s.prevView()

    expect(a).not.toBe(b)
    expect(a.itemBoxes.length).toBe(boxes)
    expect(b.itemBoxes.length).toBe(boxes)
    expect(a.karts.length).toBe(MAX_KARTS)
    expect(a.entities.length).toBe(MAX_ENTITIES)

    s.swapViews()
    expect(s.currentView()).toBe(b)
    expect(s.prevView()).toBe(a)
    s.swapViews()
    expect(s.currentView()).toBe(a)
    expect(s.prevView()).toBe(b)

    // Exactly two buffers exist, forever: nothing allocates per frame.
    const seen = new Set<unknown>()
    for (let i = 0; i < 8; i++) {
      seen.add(s.currentView())
      seen.add(s.prevView())
      s.swapViews()
    }
    expect(seen.size).toBe(2)
    s.close()
  })
})

describe('guest-only surfaces', () => {
  it('samples remote seats from the interpolator and never the local one', () => {
    const pair = makeSessionPair()
    const it = intent(0.2, 1)
    for (let t = 1; t <= 260; t++) {
      pair.host.tickOnce(it)
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(t, 0))
    }
    const now = renderNowMs(pair.guest.state().tick, 0)

    expect(pair.guest.sampleRemoteKart(1, now)).toBeNull() // seat 1 IS the guest
    const remote = pair.guest.sampleRemoteKart(0, now)
    expect(remote).not.toBeNull()
    expect(remote?.kart.playerId).toBe(0)

    // Host and solo have no interpolator at all.
    expect(pair.host.sampleRemoteKart(1, now)).toBeNull()
    expect(pair.host.sampleRemoteEntity(1, now)).toBeNull()
    expect(pair.host.remoteEntityIds(new Int32Array(MAX_ENTITIES))).toBe(0)
    expect(pair.host.corrections()).toBe(0)

    pair.host.close()
    pair.guest.close()
  })

  it('correctionDelta is null on host and solo, and zeroes outPos', () => {
    const s = makeSolo()
    const out = { x: 9, y: 9, z: 9 }
    s.tickOnce(intent(0, 1))
    expect(s.correctionDelta(out)).toBeNull()
    expect(out).toEqual({ x: 0, y: 0, z: 0 })
    s.close()
  })

  it('reports a correction on exactly the ticks ClientLoop counted one', () => {
    const pair = makeSessionPair()
    const out = { x: 0, y: 0, z: 0 }
    const it = { tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false }
    let seenNonNull = 0
    let mismatches = 0

    for (let t = 1; t <= 600; t++) {
      // A CHANGING intent is what produces corrections; a held-steady one
      // produces about one per 600 ticks (§4.9a).
      it.steer = Math.sin(t / 12)
      const before = pair.guest.corrections()
      pair.host.tickOnce({ tick: 0, steer: 0.1, accel: 1, brake: false, drift: false, useItem: false })
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(t, 0))
      const corrected = pair.guest.corrections() > before
      const delta = pair.guest.correctionDelta(out)
      if (delta !== null) seenNonNull++
      if (corrected !== (delta !== null)) mismatches++
    }

    // Vacuity guard first: a run with zero corrections would let a
    // never-reports-anything implementation pass the agreement check below.
    expect(pair.guest.corrections()).toBeGreaterThan(0)
    expect(seenNonNull).toBeGreaterThan(0)
    expect(mismatches).toBe(0)

    pair.host.close()
    pair.guest.close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/session.test.ts`

Expected: FAIL at collection with
`Error: Failed to load url ../src/localinput (resolved id: .../packages/game/src/localinput) ... Does the file exist?`
— `packages/game/src/localinput.ts` and `packages/game/src/session.ts` do not exist yet, so nothing in the file runs.

- [ ] **Step 3a: Write `packages/game/src/localinput.ts`**

```ts
// PURE — one composition, no DOM, no clock, no state of its own.
//
// `withLocalInput`, `createNullTransport`, `LocalInputTransport` and
// `LOCAL_PEER_ID` are @tapkart/net exports (§2.5, R42): a transport decorator is
// a transport, and `net` owns transports. This module composes them and defines
// nothing.
import { createNullTransport, withLocalInput } from '@tapkart/net'
import type { LocalInputTransport } from '@tapkart/net'

/**
 * Q15's "LoopbackTransport with zero peers, zero latency, zero loss", composed
 * from net's two pieces: a transport with nobody on the other end, wrapped so
 * the solo player's own intent still reaches the AuthorityLoop through the real
 * `encodeInput` codec. One object, one code path, and the same AuthorityLoop the
 * host runs — including the identical 8-bit steer / 6-bit accel quantisation
 * every guest's input crosses, so a solo player drives the same car a networked
 * one does.
 *
 * `AuthorityLoop.tick()` broadcasts unconditionally without consulting `peers()`
 * (§2.4 fact 3), so the inner transport must DROP rather than queue.
 * `createNullTransport` does exactly that.
 */
export function createSoloTransport(): LocalInputTransport {
  return withLocalInput(createNullTransport())
}
```

- [ ] **Step 3b: Write `packages/game/src/session.ts`**

```ts
// PURE — the composition root for one race. No DOM, no wall clock, no `three`.
// SOLE CONSTRUCTOR of a net loop in the entire game package (§5.10).
import type { Intent, SimContext, SimState, Vec3 } from '@tapkart/sim'
import { COUNTDOWN_TICKS, MAX_KARTS, allocStateLike, cloneState, createState } from '@tapkart/sim'
import type {
  LocalInputTransport,
  RemoteEntitySample,
  RemoteInterpolator,
  RemoteSample,
  Transport,
} from '@tapkart/net'
import { AuthorityLoop, ClientLoop, correctionDeltaOf, remoteInterpolatorOf } from '@tapkart/net'
import type { RaceView, ViewRole } from '@tapkart/render'
import { createRaceView } from '@tapkart/render'

export interface SessionOptions {
  role: ViewRole
  /** ctx.isLeader MUST equal (role !== 'guest'). */
  ctx: SimContext
  /** 0..MAX_KARTS-1; -1 is not allowed. */
  localPlayerId: number
  seed: number
  /** Length MAX_KARTS. Copied, not retained. */
  characterIdx: number[]
  /** NEVER null (Q15). Host and solo must pass a LocalInputTransport. */
  transport: Transport
}

export interface RaceSession {
  readonly role: ViewRole
  readonly localPlayerId: number
  readonly ctx: SimContext
  /** The characterIdx of every seat. THE source for KartView.characterIdx in
   *  every role, because WireKart does not carry it (§2.3). Length MAX_KARTS. */
  readonly characterIdx: readonly number[]
  /** The tick the race clock counts from. COUNTDOWN_TICKS in every role, because
   *  R44 puts `phase` on the wire and every role now starts in 'countdown'. */
  readonly raceStartTick: number

  /** Advance exactly one 60 Hz sim tick with the local player's intent.
   *  Copies the pre-tick state into the prev buffer FIRST, then ticks. */
  tickOnce(localIntent: Intent): void

  /** The state this session is entitled to read. Host/solo: the authoritative
   *  state. Guest: the predicted state, whose remote seats §7.1 forbids drawing.
   *  Live, never a copy — callers must not mutate it. */
  state(): SimState

  /** The state as of the previous tick, for Q9's sub-tick lerp. Allocated ONCE,
   *  at construction. Equal to `state()` before the first tickOnce. */
  prevState(): SimState

  /** Guest only: the interpolated pose plus the authoritative WireKart for a
   *  remote seat, ~100 ms in the past. null on host/solo and for the local seat. */
  sampleRemoteKart(playerId: number, nowMs: number): RemoteSample | null

  /** Guest only (Q4). null on host/solo and for an entity absent from the newest
   *  keyframe (it despawned). */
  sampleRemoteEntity(entityId: number, nowMs: number): RemoteEntitySample | null

  /** Guest only (Q4, R43): the live entity ids in the newest keyframe, written
   *  into `out` (length MAX_ENTITIES), returning the count. 0 on host/solo. */
  remoteEntityIds(out: Int32Array): number

  /** Reconciliation corrections so far; 0 on host/solo. */
  corrections(): number

  /** R41/R47/R48. Writes the position delta the last reconciliation applied to
   *  the local kart into `outPos` and returns its heading delta in radians;
   *  returns `null` — writing (0,0,0) — when the most recent tick applied no
   *  correction. Always `null` on host and solo, which never reconcile.
   *
   *  It DELEGATES to `correctionDeltaOf` and computes nothing: ClientLoop knows
   *  the true vector and angle at the instant it applies them, and any
   *  reconstruction from before/after states assumes constant velocity across the
   *  tick — degrading exactly when the kart is accelerating hardest, which is
   *  when a correction is most likely and most visible.
   *
   *  `null` and `0` are different answers and both are meaningful: a
   *  reconciliation that moved the heading by exactly zero still restarts the
   *  ease window. Valid until the next tickOnce. */
  correctionDelta(outPos: Vec3): number | null

  /** The RaceView THIS frame is built into (§5.11's `out`).
   *
   *  There are two, because `buildAudioModel(prev, view, out)` (§4.9) derives
   *  every one-shot cue from the delta between consecutive views, and
   *  `ViewBuilder.build` is the sole writer of every RaceView field. With one
   *  view, `prev` IS `view`, every delta is empty, and no cue can ever fire in
   *  the shipped game. The session owns both because it owns the race's lifetime
   *  and knows `ctx.track.itemBoxes.length`. */
  currentView(): RaceView

  /** The RaceView the PREVIOUS frame was built into — buildAudioModel's `prev`. */
  prevView(): RaceView

  /** Exchanges the two views. The shell calls this ONCE per frame, AFTER
   *  `audio.apply` — cues are consumed in the frame they are raised, so swapping
   *  any earlier drops them. Both views are primed by `createViewBuilder`
   *  (§5.11) before the first frame, so frame 1's delta is empty rather than "a
   *  real view minus a zeroed one", which would fire a burst of spurious cues on
   *  the grid. */
  swapViews(): void

  close(): void
}

const ZERO_DELTA_HEADING = null

function hasLocalInput(t: Transport): t is LocalInputTransport {
  return typeof (t as Partial<LocalInputTransport>).submitLocalInput === 'function'
}

class Session implements RaceSession {
  readonly role: ViewRole
  readonly localPlayerId: number
  readonly ctx: SimContext
  readonly characterIdx: readonly number[]
  readonly raceStartTick: number = COUNTDOWN_TICKS

  private readonly transport: Transport
  private readonly authority: AuthorityLoop | null
  private readonly localTransport: LocalInputTransport | null
  private readonly client: ClientLoop | null
  private readonly interp: RemoteInterpolator | null

  private readonly live: SimState
  private readonly prev: SimState

  private viewA: RaceView
  private viewB: RaceView

  constructor(opts: SessionOptions) {
    this.role = opts.role
    this.localPlayerId = opts.localPlayerId
    this.ctx = opts.ctx
    this.characterIdx = opts.characterIdx.slice()
    this.transport = opts.transport

    if (opts.role === 'guest') {
      const client = new ClientLoop(opts.ctx, opts.localPlayerId, opts.transport)
      this.client = client
      this.interp = remoteInterpolatorOf(client)
      this.authority = null
      this.localTransport = null
      // ClientLoop builds its own predicted state with seed 0 and an all-zero
      // characterIdx (§2.4 fact 4), which is why `this.characterIdx` — not
      // `state()` — is the source for that field.
      this.live = client.state()
    } else {
      // Host and solo are IDENTICAL: R44 puts `phase` on the wire, so a host
      // counts down and every guest sees it. There is no longer a reason for the
      // two to differ.
      const state = createState(opts.ctx, opts.seed, opts.characterIdx.slice())
      state.karts[opts.localPlayerId].isBot = false
      state.karts[opts.localPlayerId].connected = true
      this.live = state
      this.authority = new AuthorityLoop(opts.ctx, state, opts.transport)
      this.localTransport = opts.transport as LocalInputTransport
      this.client = null
      this.interp = null
    }

    this.prev = allocStateLike(opts.ctx, this.live)
    cloneState(this.live, this.prev)

    const boxes = opts.ctx.track.itemBoxes.length
    this.viewA = createRaceView(boxes)
    this.viewB = createRaceView(boxes)
  }

  tickOnce(localIntent: Intent): void {
    cloneState(this.live, this.prev)
    // Stamp the tick here, once, rather than trusting every caller to. Two
    // separate consumers read this field: AuthorityLoop keeps an intent only
    // when `it.tick > heldIntentTick[playerId]`, and `withLocalInput` reads it
    // to decide which ticks go on the 30 Hz wire. A caller that leaves it at 0
    // therefore does not fail loudly — it silently delivers one input and then
    // nothing, which looks exactly like a kart that will not steer.
    localIntent.tick = this.live.tick + 1
    const client = this.client
    if (client !== null) {
      client.tick(localIntent)
      return
    }
    const authority = this.authority
    const local = this.localTransport
    if (authority === null || local === null) {
      throw new Error('RaceSession: no loop for this role')
    }
    // AuthorityLoop has no other input path (§2.4 fact 1, §5.10a). Called on
    // EVERY sim tick, with no cadence of our own: `withLocalInput` applies the
    // 30 Hz wire cadence internally and drops the odd ticks, which is precisely
    // what makes the solo player's input path the same shape as a guest's.
    local.submitLocalInput(this.localPlayerId, localIntent)
    authority.tick()
  }

  state(): SimState {
    return this.live
  }

  prevState(): SimState {
    return this.prev
  }

  sampleRemoteKart(playerId: number, nowMs: number): RemoteSample | null {
    const interp = this.interp
    if (interp === null || playerId === this.localPlayerId) return null
    return interp.sampleKart(playerId, nowMs)
  }

  sampleRemoteEntity(entityId: number, nowMs: number): RemoteEntitySample | null {
    const interp = this.interp
    if (interp === null) return null
    return interp.sampleEntity(entityId, nowMs)
  }

  remoteEntityIds(out: Int32Array): number {
    const interp = this.interp
    if (interp === null) return 0
    return interp.liveEntityIds(out)
  }

  corrections(): number {
    const client = this.client
    return client === null ? 0 : client.corrections()
  }

  correctionDelta(outPos: Vec3): number | null {
    const client = this.client
    if (client === null) {
      outPos.x = 0
      outPos.y = 0
      outPos.z = 0
      return ZERO_DELTA_HEADING
    }
    return correctionDeltaOf(client, outPos)
  }

  currentView(): RaceView {
    return this.viewA
  }

  prevView(): RaceView {
    return this.viewB
  }

  swapViews(): void {
    const t = this.viewA
    this.viewA = this.viewB
    this.viewB = t
  }

  close(): void {
    this.transport.close()
  }
}

/**
 * Wires AuthorityLoop (host/solo) or ClientLoop (guest) over the given
 * Transport. SOLE CONSTRUCTOR of a net loop in the entire game package.
 *
 * Every precondition is checked here and throws, because each one fails
 * silently at runtime otherwise: a plain Transport on a host means the host's
 * kart is driven by bot AI forever (§2.4 fact 1), a wrong `isLeader` means item
 * rolls and event emission stop or double, and a negative localPlayerId indexes
 * nothing.
 */
export function createSession(opts: SessionOptions): RaceSession {
  if (opts.characterIdx.length !== MAX_KARTS) {
    throw new Error(
      `createSession: characterIdx must have length ${MAX_KARTS}, got ${opts.characterIdx.length}`,
    )
  }
  if (!(opts.localPlayerId >= 0 && opts.localPlayerId < MAX_KARTS)) {
    throw new Error(
      `createSession: localPlayerId ${opts.localPlayerId} is outside [0, ${MAX_KARTS})`,
    )
  }
  const wantLeader = opts.role !== 'guest'
  if (opts.ctx.isLeader !== wantLeader) {
    throw new Error(
      `createSession: ctx.isLeader must be ${wantLeader} for role '${opts.role}', got ${opts.ctx.isLeader}`,
    )
  }
  if (wantLeader && !hasLocalInput(opts.transport)) {
    throw new Error(
      `createSession: role '${opts.role}' requires a LocalInputTransport — wrap the transport with withLocalInput() from @tapkart/net, or use createSoloTransport()`,
    )
  }
  return new Session(opts)
}
```

- [ ] **Step 3c: Append the three fixtures to `packages/game/test/fixtures/game-fixtures.ts`**

Append exactly this — do **not** rewrite the file. The imports go at the top with
the existing ones; the functions go at the bottom, after
`makeControlInputsFixture`, `makeSettingsFixture` and `makeLobbySlots`.

`makeGameContext` first, if it is not already present. It is §9.1's, no earlier
task owns it, and both fixtures below need it:

```ts
import type { SimContext } from '@tapkart/sim'
// §2.6: test fixtures are reached by RELATIVE path, test-to-test only. `src`
// never does this, and @tapkart/sim's exports are not widened to publish them.
import { makeContext, makeOvalTrack } from '../../../sim/test/fixtures/track-fixtures'

/** The context every game-side test races on: sim's own oval fixture, whose
 *  tuning and characters are the ones Q1 requires the shipped content to equal
 *  field for field. A guest's context must be built with isLeader false — only a
 *  leader authority rolls items and advances rngCursor. */
export function makeGameContext(isLeader = true): SimContext {
  return makeContext(makeOvalTrack(), isLeader)
}
```

Then the two session fixtures:

```ts
import type { LoopbackOptions } from '@tapkart/net'
import { makeLoopbackPair, withLocalInput } from '@tapkart/net'
import type { RaceSession } from '../../src/session'
import { createSession } from '../../src/session'
import { renderNowMs } from '../../src/clock'

/** Plan 2's conditions, which are spec §8's. */
const DEFAULT_LOOPBACK: LoopbackOptions = {
  latencyMs: 150,
  jitterMs: 50,
  lossRate: 0.05,
  seed: 0xc0ffee,
}

const PAIR_CHARACTER_IDX = [0, 1, 2, 3, 4, 5, 6, 7]

/**
 * Host + guest over ONE shared loopback pair. The host's side is wrapped with
 * `withLocalInput` (§5.10a); the guest's ClientLoop needs no wrapper, since
 * `tick(localIntent)` already takes one.
 *
 * The guest's seat is flipped to `isBot: false, connected: true` on the HOST's
 * state. Without that flip, `resolveInputs` drives the guest's seat with bot AI
 * on the authority (§2.4 fact 2) and every test built on this pair measures
 * nothing: the guest would be predicting a seat the host never lets it steer.
 */
export function makeSessionPair(opts: Partial<LoopbackOptions> = {}): {
  host: RaceSession
  guest: RaceSession
  pump(nowMs: number): void
} {
  const pair = makeLoopbackPair({ ...DEFAULT_LOOPBACK, ...opts })
  const host = createSession({
    role: 'host',
    ctx: makeGameContext(true),
    localPlayerId: 0,
    seed: 0x7A1E,
    characterIdx: PAIR_CHARACTER_IDX.slice(),
    transport: withLocalInput(pair.a),
  })
  const guest = createSession({
    role: 'guest',
    ctx: makeGameContext(false),
    localPlayerId: 1,
    seed: 0x7A1E,
    characterIdx: PAIR_CHARACTER_IDX.slice(),
    transport: pair.b,
  })
  host.state().karts[1].isBot = false
  host.state().karts[1].connected = true
  return { host, guest, pump: pair.pump }
}

/**
 * A guest session whose ClientLoop has taken N corrections, for R41's smoothing
 * tests. It drives a CHANGING (sine) intent, which is what actually produces
 * corrections: a held-steady intent produces about one per 600 ticks, and a
 * changing one about three per second (§4.9a). A fixture that held the intent
 * steady would hand every smoothing test a run with nothing to smooth.
 */
export function makeCorrectingGuest(ticks = 600): {
  host: RaceSession
  guest: RaceSession
  pump(nowMs: number): void
  corrections(): number
} {
  const pair = makeSessionPair()
  const hostIntent = { tick: 0, steer: 0.1, accel: 1, brake: false, drift: false, useItem: false }
  const guestIntent = { tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false }
  for (let t = 1; t <= ticks; t++) {
    guestIntent.steer = Math.sin(t / 12)
    pair.host.tickOnce(hostIntent)
    pair.guest.tickOnce(guestIntent)
    pair.pump(renderNowMs(t, 0))
  }
  return { ...pair, corrections: () => pair.guest.corrections() }
}
```

If the file does not exist at all, create it with the three blocks above and
leave `makeControlInputsFixture`, `makeSettingsFixture` and `makeLobbySlots` to
the tasks that own them (17, 18, 19).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/session.test.ts`
Expected: 12 passing.

Then typecheck: `npx tsc --noEmit -p packages/game/tsconfig.json` — expected: no output.

**What each test catches, and whether it would actually fail under that bug:**

| Test | Bug | Fails? |
|---|---|---|
| starts in countdown | a host started at `'racing'` (the pre-R44 workaround) | yes — `phase` is a plain string comparison |
| flips the local seat | forgetting §2.4 fact 2 — the local kart is bot-driven on the authority | yes |
| carries characterIdx | reading `characterIdx` off `state()` on a guest | yes — the two sources are provably different (2 vs 0) *before* the assertion |
| copies characterIdx | retaining the caller's array | yes |
| rejects a plain Transport | a host silently bot-driven forever | yes |
| left/right/neutral separation | `submitLocalInput` not called, or called with a non-increasing `intent.tick`, or a `null` transport path | yes — under the bug all three runs are the same bot-driven kart and every separation is exactly 0. `resetBotHold()` and sequential (never interleaved) runs are what make that exact |
| prevState trails by one | cloning after the tick instead of before, or allocating per frame | yes — the delta would be 0, and Q9's lerp would be a silent no-op |
| two views, swap in place | one view (the contract defect), or allocating a view per frame | yes — `not.toBe` and the two-identity set |
| remote sampling | sampling the local seat from the interpolator, or building an interpolator on a host | yes |
| correctionDelta null on host | reconstructing a delta from before/after states, which on a host is nonzero garbage every tick | yes |
| correction agreement | always-null (smoothing never fires, R41's defect invisible) or always-non-null (the ease window re-seeds every tick and never decays) | yes, and the `corrections() > 0` guard first means the run cannot pass vacuously |

- [ ] **Step 5: Commit**

```bash
git add packages/game/src/session.ts packages/game/src/localinput.ts \
        packages/game/test/session.test.ts packages/game/test/fixtures/game-fixtures.ts && \
git commit -m "feat(game): race session composition root, solo transport and the double view buffer"
```
