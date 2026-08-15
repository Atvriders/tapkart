### Task 21: `packages/game/src/view.ts` — the one place prediction and interpolation are chosen between

**Files:**
- Create: `packages/game/src/view.ts`
- Create: `packages/game/src/vite-env.d.ts` — one line; this task creates it because `view.ts` is the first module in the repository to name `import.meta.env.DEV`, and without it `tsc --noEmit` fails with *"Property 'env' does not exist on type 'ImportMeta'"*. Task 22 verifies it exists rather than creating it.
- Test: `packages/game/test/view.test.ts`
- Test: `packages/game/test/frameloop.test.ts`

**Interfaces:**

- Consumes, from `./session` (Task 20 — the whole interface, verbatim):
  ```ts
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
    currentView(): RaceView
    prevView(): RaceView
    swapViews(): void
    close(): void
  }
  export function createSession(opts: SessionOptions): RaceSession
  ```
- Consumes, from `./clock` (Task 16):
  ```ts
  export function renderNowMs(tick: number, alpha: number): number   // (tick + alpha) * TICK_MS
  ```
- Consumes, from `@tapkart/render` (§4.2, §4.9a):
  ```ts
  export type ViewRole = 'host' | 'guest' | 'solo'
  export type ViewSource = 'authoritative' | 'predicted' | 'interpolated' | 'absent'
  export interface KartView { playerId: number; characterIdx: number; source: ViewSource
    position: Vec3; heading: number; velocity: Vec3; angularVelocity: number; speed: number
    s: number; bankAngle: number; driftActive: boolean; driftDir: -1 | 0 | 1
    driftCharge: number; driftTier: number; airborne: boolean; surface: Surface
    spinOutTicks: number; invulnTicks: number; boostTicks: number; respawnTicks: number
    shielded: boolean; item: ItemKind; lap: number; checkpointIdx: number; t: number
    place: number; isBot: boolean; connected: boolean }
  export interface EntityView { entityId: number; kind: EntityKind; ownerId: number
    source: ViewSource; position: Vec3; velocity: Vec3; heading: number; ttl: number }
  export interface ItemBoxView { boxIdx: number; position: Vec3; respawnTicks: number }
  export interface RaceView { tick: number; alpha: number; phase: RacePhase
    localPlayerId: number; raceStartTick: number; karts: KartView[]; entities: EntityView[]
    entityCount: number; itemBoxes: ItemBoxView[]; itemBoxRespawnTicks: number
    finishedOrder: number[]; finishTick: number; countdownTicksLeft: number }
  export function createRaceView(itemBoxCount: number): RaceView
  export function viewSourceViolations(view: RaceView, role: ViewRole): string[]
  export interface VisualOffset { origin: Vec3; originHeading: number; ticksSince: number
    current: Vec3; currentHeading: number }
  export function createVisualOffset(): VisualOffset
  export function advanceVisualOffset(prev: VisualOffset, correctionPos: Vec3,
                                      correctionHeading: number | null,
                                      ticksElapsed: number, out: VisualOffset): void
  export const ERROR_SMOOTH_WINDOW_TICKS = 12     // frameloop.test.ts only
  ```
- Consumes, from `@tapkart/sim` (§2.1, §2.2):
  ```ts
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export const COUNTDOWN_TICKS = 180
  export function allocStateLike(ctx: SimContext, src: SimState): SimState
  export function computePlacement(state: SimState, outIndexOf: Int32Array, outOrder: Int32Array): void
  export function driftTierFor(charge: number, tiers: [number, number, number]): number   // -1 = none
  export function itemBoxWorldPos(ctx: SimContext, boxIdx: number, out: Vec3): void       // writes out, returns void
  export function wrapAngle(a: number): number                                            // (-π, π]
  export function spawnEntity(state: SimState, kind: EntityKind, ownerId: number, position: Vec3,
                              heading: number, targetId: number, ttl: number,
                              events: AuthEvent[]): number    // packages/sim/src/entity.ts:45
  ```
- Consumes, from `@tapkart/protocol` (§2.3): `WireKart`, `WireEntity` — used only by the test's fake session.
- Consumes, from `./fixtures/game-fixtures` (Task 20 / §9.1): `makeGameContext`,
  `makeSessionPair`, and **`makeCorrectingGuest`** — §9.1's fixture for R41, whose
  only consumer in the plan is this task's end-to-end smoothing test. It exists
  because a held-steady intent produces about one correction per 600 ticks, so a
  smoothing test driven by one would have nothing to smooth.
- Consumes, from `@tapkart/sim`, in the tests only: `TICK_DT`, `cloneState`,
  `createState`, `resetBotHold`, `RACE_LAPS`.

- Produces:
  ```ts
  // packages/game/src/view.ts
  export interface ViewBuilder {
    /** Fills `out` from the session captured at construction, obeying §7.1 seat
     *  by seat. SOLE WRITER of every RaceView field. Allocates nothing. */
    build(alpha: number, out: RaceView): void
  }
  /** Allocates the builder's scratch ONCE, and PRIMES both of the session's
   *  views before returning. */
  export function createViewBuilder(session: RaceSession): ViewBuilder
  ```
  Task 22 (`shell.ts`) calls `createViewBuilder(session)` once per race and
  `build(alpha, session.currentView())` once per frame.

**The seat-source rule — this task's whole reason to exist**

Contract §7.1, from spec §5: **the renderer reads the LOCAL seat from
`ClientLoop.state()` and EVERY OTHER seat from the `RemoteInterpolator`, and
never both.**

This exists because of a real functional gap: `ClientLoop` never applies the
snapshot to non-local seats, so the other seven karts in `state()` are the local
sim's own **bot AI** (`packages/net/src/client.ts:150-153`). Every remote lap
counter, standings row and held-item icon a guest saw would have been fiction.
`RemoteSample.kart: WireKart` is the fix — the newest authoritative record,
verbatim off the wire — so interpolated `position`/`heading` come from the
interpolation and **every discrete field** comes from `sample.kart`.

Resolved per role, per seat:

| Role | Local seat | Remote seats | Entities | Item boxes |
|---|---|---|---|---|
| `solo` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()`, unpoliced |
| `host` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()`, unpoliced |
| `guest` | `state()` → `'predicted'` | `sampleRemoteKart()` → `'interpolated'`; `null` → `'absent'` | `sampleRemoteEntity()` → `'interpolated'`; absent ids simply not listed | `state()`, unpoliced |

Two related details. **Item boxes are `'predicted'` on purpose** (R45): putting
box state on the wire costs ~8 bits × 16 boxes = 128 bits against a 180-bit
snapshot, at 20 Hz, to correct a purely cosmetic ghost, and every real pickup is
already corrected by the reliable `itemGrant` stream. `ItemBoxView` has no
`source` field and `viewSourceViolations` deliberately says nothing about boxes —
there is no rule to state, so none is faked. And **Q9's alpha-lerp applies to
every `state()`-sourced seat and entity, not only the local one**: on a host the
other seven seats come from the same `state()` and would otherwise judder alone
at 60 Hz on a 120 Hz display (§15.3).

`viewSourceViolations` is the instrument, and it runs **under
`import.meta.env.DEV` in dev builds as well as in CI tests** (Q32): a test proves
the invariant for the cases someone thought of, a dev assertion proves it for the
ones nobody did. Vitest sets `DEV` true, so both the tests and the assertion are
live in this task's suite.

---

- [ ] **Step 1: Write the failing tests**

Create `packages/game/test/view.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent, SimState, Vec3 } from '@tapkart/sim'
import {
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  allocStateLike,
  cloneState,
  createState,
  resetBotHold,
  spawnEntity,
  wrapAngle,
} from '@tapkart/sim'
import type { WireEntity, WireKart } from '@tapkart/protocol'
import { createRaceView, viewSourceViolations } from '@tapkart/render'
import { renderNowMs } from '../src/clock'
import { createSoloTransport } from '../src/localinput'
import type { RaceSession } from '../src/session'
import { createSession } from '../src/session'
import { createViewBuilder } from '../src/view'
import { makeGameContext, makeSessionPair } from './fixtures/game-fixtures'

const CHARACTER_IDX = [3, 5, 1, 7, 2, 6, 0, 4]

function intent(steer: number, accel: number): Intent {
  return { tick: 0, steer, accel, brake: false, drift: false, useItem: false }
}

function makeSolo(localPlayerId = 0): RaceSession {
  resetBotHold()
  return createSession({
    role: 'solo',
    ctx: makeGameContext(true),
    localPlayerId,
    seed: 0x5eed,
    characterIdx: CHARACTER_IDX.slice(),
    transport: createSoloTransport(),
  })
}

// ---------------------------------------------------------------------------
// A hand-built RaceSession. `ViewBuilder` consumes the interface, so a fake is
// the only way to put the two sources into a state a real race cannot reach —
// which is exactly what the placement and dev-assertion cases below need.
// ---------------------------------------------------------------------------
interface FakeOpts {
  localPlayerId: number
  wireKart?: (playerId: number) => WireKart | null
  entityIds?: readonly number[]
  wireEntity?: (entityId: number) => WireEntity | null
}

function makeWireKart(playerId: number, lap: number, t: number): WireKart {
  return {
    playerId,
    position: { x: playerId * 10, y: 0, z: 0 },
    velocity: { x: 3, y: 0, z: 0 },
    heading: 0,
    angularVelocity: 0,
    driftCharge: 0,
    driftActive: false,
    driftDir: 0,
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    item: 'none',
    lap,
    checkpointIdx: 0,
    t,
    isBot: true,
    connected: true,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
  }
}

function makeFakeGuest(opts: FakeOpts): RaceSession {
  const ctx = makeGameContext(false)
  const state: SimState = createState(ctx, 0, [0, 0, 0, 0, 0, 0, 0, 0])
  state.phase = 'racing'
  // The bot-AI fiction ClientLoop.state() actually contains for remote seats:
  // every one of them "leading" on lap 9. Nothing built from the wire may ever
  // reproduce these numbers, which is what makes the assertions below decisive.
  for (let i = 0; i < MAX_KARTS; i++) {
    state.karts[i].lap.lap = 9
    state.karts[i].lap.checkpointIdx = 0
    state.karts[i].lap.t = 0.99
  }
  if (opts.localPlayerId >= 0) state.karts[opts.localPlayerId].lap.lap = 0
  const prev = allocStateLike(ctx, state)
  cloneState(state, prev)
  const boxes = ctx.track.itemBoxes.length
  let a = createRaceView(boxes)
  let b = createRaceView(boxes)
  return {
    role: 'guest',
    localPlayerId: opts.localPlayerId,
    ctx,
    characterIdx: CHARACTER_IDX.slice(),
    raceStartTick: COUNTDOWN_TICKS,
    tickOnce: () => undefined,
    state: () => state,
    prevState: () => prev,
    sampleRemoteKart: (playerId) => {
      if (playerId === opts.localPlayerId) return null
      const k = opts.wireKart === undefined ? null : opts.wireKart(playerId)
      return k === null ? null : { position: { ...k.position }, heading: k.heading, kart: k }
    },
    sampleRemoteEntity: (entityId) => {
      const e = opts.wireEntity === undefined ? null : opts.wireEntity(entityId)
      return e === null ? null : { position: { ...e.position }, heading: e.heading, entity: e }
    },
    remoteEntityIds: (out) => {
      const ids = opts.entityIds ?? []
      for (let i = 0; i < ids.length; i++) out[i] = ids[i]
      return ids.length
    },
    corrections: () => 0,
    correctionDelta: (outPos: Vec3) => {
      outPos.x = 0
      outPos.y = 0
      outPos.z = 0
      return null
    },
    currentView: () => a,
    prevView: () => b,
    swapViews: () => {
      const t = a
      a = b
      b = t
    },
    close: () => undefined,
  }
}

describe('the seat-source rule (§7.1) — the flagship', () => {
  it('a real guest sees no violations over 600 ticks, and really does interpolate', () => {
    const pair = makeSessionPair()
    // A slick sits still, is never despawned on contact (only seekers and bolts
    // are) and lives its full ttl, so the guest's interpolator is guaranteed a
    // remote entity to sample. Waiting for a bot to roll one would make this
    // test's precondition a matter of luck.
    const owner = pair.host.state().karts[3]
    const spawnEvents: AuthEvent[] = []
    spawnEntity(
      pair.host.state(),
      'slick',
      3,
      { x: owner.position.x + 2, y: owner.position.y, z: owner.position.z + 2 },
      0,
      -1,
      600,
      spawnEvents,
    )

    const gb = createViewBuilder(pair.guest)
    const hb = createViewBuilder(pair.host)
    const it = intent(0.3, 1)
    let sawInterpolatedSeat = 0
    let sawInterpolatedEntity = 0
    let violations = 0

    for (let t = 1; t <= 600; t++) {
      pair.host.tickOnce(it)
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(t, 0))

      const gv = pair.guest.currentView()
      gb.build(0.5, gv)
      violations += viewSourceViolations(gv, 'guest').length
      for (let i = 0; i < MAX_KARTS; i++) if (gv.karts[i].source === 'interpolated') sawInterpolatedSeat++
      for (let j = 0; j < gv.entityCount; j++) if (gv.entities[j].source === 'interpolated') sawInterpolatedEntity++
      pair.guest.swapViews()

      const hv = pair.host.currentView()
      hb.build(0.5, hv)
      violations += viewSourceViolations(hv, 'host').length
      pair.host.swapViews()
    }

    expect(violations).toBe(0)
    // Without these two, an all-'absent' view would pass the line above while
    // proving nothing at all.
    expect(sawInterpolatedSeat).toBeGreaterThan(0)
    expect(sawInterpolatedEntity).toBeGreaterThan(0)

    pair.host.close()
    pair.guest.close()
  })

  it('reads a remote seat from the wire even when the prediction says otherwise', () => {
    const pair = makeSessionPair()
    const b = createViewBuilder(pair.guest)
    const it = intent(0.2, 1)
    for (let t = 1; t <= 300; t++) {
      pair.host.tickOnce(it)
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(t, 0))
    }

    // Make the two sources PROVABLY different before asserting which was read.
    // These are the local sim's bot-AI values for seat 2 — the values §7.1
    // exists to keep off the screen.
    const fiction = pair.guest.state().karts[2]
    fiction.position.x += 500
    fiction.lap.lap = 7
    fiction.drift.charge = 999
    fiction.shielded = true
    fiction.item = 'bolt'

    const now = renderNowMs(pair.guest.state().tick, 0.5)
    const wire = pair.guest.sampleRemoteKart(2, now)
    expect(wire).not.toBeNull()
    expect(wire?.kart.lap).not.toBe(7)

    const view = pair.guest.currentView()
    b.build(0.5, view)
    const seat = view.karts[2]

    expect(seat.source).toBe('interpolated')
    expect(seat.lap).toBe(wire?.kart.lap)
    expect(seat.driftCharge).toBe(wire?.kart.driftCharge)
    expect(seat.shielded).toBe(wire?.kart.shielded)
    expect(seat.item).toBe(wire?.kart.item)
    expect(seat.position.x).toBeCloseTo(wire?.position.x ?? NaN, 9)
    // The prediction is 500 m away. If the builder read state() this is ~0.
    expect(Math.abs(seat.position.x - fiction.position.x)).toBeGreaterThan(100)

    // And the LOCAL seat is still read from state(): move it and the view follows.
    const before = view.karts[1].position.x
    pair.guest.state().karts[1].position.x += 500
    b.build(0.5, view)
    expect(view.karts[1].source).toBe('predicted')
    expect(view.karts[1].position.x - before).toBeGreaterThan(100)

    pair.host.close()
    pair.guest.close()
  })

  it('passes the interpolator a tick-derived nowMs, not a wall clock (§6.3)', () => {
    const pair = makeSessionPair()
    const b = createViewBuilder(pair.guest)
    const it = intent(0.2, 1)
    for (let t = 1; t <= 300; t++) {
      pair.host.tickOnce(it)
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(t, 0))
    }

    const alpha = 0.5
    const tickNow = renderNowMs(pair.guest.state().tick, alpha)
    const wallish = 3_600_000 // an hour of uptime, which is what performance.now() looks like
    const correct = pair.guest.sampleRemoteKart(2, tickNow)
    const pinnedA = pair.guest.sampleRemoteKart(2, wallish)
    const pinnedB = pair.guest.sampleRemoteKart(2, wallish + 60_000)

    // The wrong basis clamps at REMOTE_EXTRAPOLATE_CAP_MS: two instants a minute
    // apart resolve to the SAME pose. That is the §6.3 failure, made visible.
    expect(pinnedA?.position.x).toBeCloseTo(pinnedB?.position.x ?? NaN, 9)
    expect(Math.abs((correct?.position.x ?? 0) - (pinnedA?.position.x ?? 0))).toBeGreaterThan(0.01)

    const view = pair.guest.currentView()
    b.build(alpha, view)
    expect(view.karts[2].position.x).toBeCloseTo(correct?.position.x ?? NaN, 9)

    pair.host.close()
    pair.guest.close()
  })

  it('throws in a DEV build when a view violates the rule (Q32)', () => {
    // localPlayerId -1 is illegal for a guest, which is §7.1 check 1. A real
    // session cannot be built this way — createSession rejects it — so the fake
    // is what makes the dev assertion reachable at all.
    const fake = makeFakeGuest({ localPlayerId: -1 })
    const b0 = createViewBuilder(makeFakeGuest({ localPlayerId: 1 })) // prime-path sanity
    expect(b0).toBeDefined()
    expect(() => createViewBuilder(fake)).toThrow(/seat-source violations/)
  })
})

describe('Q9\'s alpha lerp', () => {
  it('applies to EVERY state-sourced seat, not only the local one (§15.3)', () => {
    const s = makeSolo(0)
    const b = createViewBuilder(s)
    const it = intent(0.4, 1)
    for (let t = 0; t < COUNTDOWN_TICKS + 40; t++) s.tickOnce(it)

    const SEAT = 5 // a bot seat, not the local one
    const p = s.prevState().karts[SEAT].position.x
    const c = s.state().karts[SEAT].position.x
    // Vacuity guard: two karts snapped to the same point would make every lerp
    // assertion below true for the wrong reason.
    expect(Math.abs(c - p)).toBeGreaterThan(1e-6)

    const view = s.currentView()
    b.build(0.25, view)
    expect(view.karts[SEAT].position.x).toBeCloseTo(p + (c - p) * 0.25, 12)
    expect(view.karts[SEAT].source).toBe('authoritative')
    s.close()
  })

  it('lerps heading the short way round', () => {
    const s = makeSolo(0)
    const b = createViewBuilder(s)
    s.tickOnce(intent(0, 0))
    s.prevState().karts[2].heading = 3.0
    s.state().karts[2].heading = -3.0

    const view = s.currentView()
    b.build(0.5, view)
    // Shortest arc: wrapAngle(-3 - 3) = +0.283…, so the halfway heading is
    // ±π, not 0. A naive (a + (b - a) * t) lerp gives 0 — a kart that spins
    // the long way round through the entire opposite bearing.
    expect(Math.abs(view.karts[2].heading)).toBeCloseTo(Math.PI, 6)
    expect(Math.abs(wrapAngle(view.karts[2].heading - 0))).toBeGreaterThan(3)
    s.close()
  })

  it('does not lerp an entity slot against a different entity', () => {
    const s = makeSolo(0)
    const b = createViewBuilder(s)
    const k = s.state().karts[0]
    spawnEntity(s.state(), 'slick', 0, { x: k.position.x, y: k.position.y, z: k.position.z }, 0, -1, 600, [])
    s.tickOnce(intent(0, 0))

    const cur = s.state().entities[0]
    const old = s.prevState().entities[0]
    // Slot reuse: the previous occupant of slot 0 was a different entity, 900 m
    // away. Lerping against it would fly a slick in from another postcode.
    old.entityId = cur.entityId + 77
    old.position.x = cur.position.x + 900

    const view = s.currentView()
    b.build(0.5, view)
    expect(view.entityCount).toBeGreaterThan(0)
    expect(view.entities[0].entityId).toBe(cur.entityId)
    expect(view.entities[0].position.x).toBeCloseTo(cur.position.x, 12)

    // With the ids matching, the same slot IS lerped.
    old.entityId = cur.entityId
    b.build(0.5, view)
    expect(view.entities[0].position.x).toBeCloseTo(cur.position.x + 450, 9)
    s.close()
  })
})

describe('derived fields', () => {
  it('takes characterIdx from the session, never from state (§2.3 fact 1)', () => {
    const pair = makeSessionPair()
    const b = createViewBuilder(pair.guest)
    const view = pair.guest.currentView()
    b.build(0, view)
    // ClientLoop's predicted state carries an all-zero characterIdx.
    expect(pair.guest.state().karts[3].characterIdx).toBe(0)
    expect(view.karts[3].characterIdx).toBe(pair.guest.characterIdx[3])
    expect(view.karts[3].characterIdx).toBe(3)
    pair.host.close()
    pair.guest.close()
  })

  it('reconstructs s from checkpointIdx and t, with the grid on the last checkpoint', () => {
    const s = makeSolo(0)
    const b = createViewBuilder(s)
    const cp = s.ctx.track.checkpointS
    const n = cp.length
    expect(n).toBeGreaterThan(1)

    const wrap01 = (v: number): number => v - Math.floor(v)
    const seg = (i: number): number => (cp[(i + 1) % n] - cp[i] + 1) % 1

    for (const kart of [s.state().karts[4], s.prevState().karts[4]]) {
      kart.lap.checkpointIdx = 0
      kart.lap.t = 0.5
    }
    const view = s.currentView()
    b.build(0, view)
    expect(view.karts[4].s).toBeCloseTo(wrap01(cp[0] + 0.5 * seg(0)), 12)

    for (const kart of [s.state().karts[4], s.prevState().karts[4]]) {
      kart.lap.checkpointIdx = -1
      kart.lap.t = 0
    }
    b.build(0, view)
    expect(view.karts[4].s).toBeCloseTo(wrap01(cp[n - 1]), 12)
    s.close()
  })

  it('computes place with computePlacement over the VIEW\'s own values', () => {
    // Wire progress: seat 0 leads, then 2, then everyone else. state() claims
    // every remote seat is on lap 9, which is the fiction placement must ignore.
    // `| undefined` in the value type is what makes `?? 0` legal under strict:
    // with noUncheckedIndexedAccess off, a bare Record<number, number> index is
    // typed `number` and comparing or defaulting it against undefined errors.
    const laps: Record<number, number | undefined> = { 0: 2, 2: 1 }
    const fake = makeFakeGuest({
      localPlayerId: 1,
      wireKart: (pid) => makeWireKart(pid, laps[pid] ?? 0, 0.1 + pid * 0.01),
    })
    const b = createViewBuilder(fake)
    const view = fake.currentView()
    b.build(0, view)

    expect(view.karts[0].lap).toBe(2)   // from the wire, not 9
    expect(view.karts[2].lap).toBe(1)
    expect(view.karts[0].place).toBe(0)
    expect(view.karts[2].place).toBe(1)
    const places = new Set<number>()
    for (let i = 0; i < MAX_KARTS; i++) places.add(view.karts[i].place)
    expect(places.size).toBe(MAX_KARTS)
    expect(viewSourceViolations(view, 'guest')).toEqual([])
  })

  it('packs sampled entities at the front and lists nothing it could not sample', () => {
    const wire: WireEntity = {
      entityId: 7,
      kind: 'seeker',
      ownerId: 3,
      position: { x: 5, y: 1, z: -2 },
      velocity: { x: 1, y: 0, z: 0 },
      heading: 0.5,
      ttl: 120,
    }
    const fake = makeFakeGuest({
      localPlayerId: 1,
      wireKart: (pid) => makeWireKart(pid, 0, 0.1),
      entityIds: [7, 9],
      wireEntity: (id) => (id === 7 ? wire : null), // 9 despawned between keyframes
    })
    const b = createViewBuilder(fake)
    const view = fake.currentView()
    b.build(0, view)

    expect(view.entityCount).toBe(1)
    expect(view.entities[0].entityId).toBe(7)
    expect(view.entities[0].source).toBe('interpolated')
    expect(view.entities[0].ttl).toBe(120)
    expect(view.entities[1].entityId).toBe(-1)
    expect(view.entities[1].source).toBe('absent')
    expect(view.entities[MAX_ENTITIES - 1].source).toBe('absent')
    expect(viewSourceViolations(view, 'guest')).toEqual([])
  })

  it('fills the scalars and allocates nothing per frame', () => {
    const s = makeSolo(0)
    const b = createViewBuilder(s)
    const view = s.currentView()
    const posIdentity = view.karts[0].position
    const boxIdentity = view.itemBoxes[0].position

    s.tickOnce(intent(0, 1))
    b.build(0.25, view)

    expect(view.tick).toBe(s.state().tick)
    expect(view.alpha).toBe(0.25)
    expect(view.phase).toBe('countdown')
    expect(view.localPlayerId).toBe(0)
    expect(view.raceStartTick).toBe(COUNTDOWN_TICKS)
    expect(view.countdownTicksLeft).toBe(COUNTDOWN_TICKS - s.state().tick)
    expect(view.finishTick).toBe(-1)
    expect(view.itemBoxRespawnTicks).toBe(s.ctx.tuning.itemBoxRespawnTicks)
    expect(view.itemBoxes.length).toBe(s.ctx.track.itemBoxes.length)
    expect(view.karts[0].position).toBe(posIdentity)
    expect(view.itemBoxes[0].position).toBe(boxIdentity)
    s.close()
  })
})
```

Create `packages/game/test/frameloop.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Intent } from '@tapkart/sim'
import { COUNTDOWN_TICKS, RACE_LAPS, TICK_DT, resetBotHold } from '@tapkart/sim'
import {
  ERROR_SMOOTH_WINDOW_TICKS,
  buildAudioModel,
  buildHudModel,
  createAudioModel,
  createHudModel,
} from '@tapkart/render'
import { renderNowMs } from '../src/clock'
import { createSoloTransport } from '../src/localinput'
import { createSession } from '../src/session'
import { createViewBuilder } from '../src/view'
import { makeCorrectingGuest, makeGameContext } from './fixtures/game-fixtures'

/** §4.9's one-shots. `engine` and `skid` are continuous levels and are excluded. */
const ONE_SHOTS = new Set([
  'lapCross', 'finish', 'spinOut', 'respawn', 'itemPickup', 'itemUse', 'boost', 'impact',
])

describe('the frame loop\'s two views (§5.10, §5.13)', () => {
  it('fires exactly one lapCross cue across a race that crosses one lap', () => {
    resetBotHold()
    const intent: Intent = { tick: 0, steer: 0.2, accel: 1, brake: false, drift: false, useItem: false }
    const session = createSession({
      role: 'solo',
      ctx: makeGameContext(true),
      localPlayerId: 0,
      seed: 0x5eed,
      characterIdx: [0, 1, 2, 3, 4, 5, 6, 7],
      transport: createSoloTransport(),
    })
    const builder = createViewBuilder(session)
    const audio = createAudioModel()
    const hud = createHudModel()

    // 60 racing ticks is about 20 m on this track, so no kart crosses the line
    // naturally in the window. The single crossing below is therefore the only
    // one, and the count is exact rather than approximate.
    const TICKS = COUNTDOWN_TICKS + 60
    const CROSS_AT = COUNTDOWN_TICKS + 30
    let lapCross = 0
    let firstFrameOneShots = 0

    for (let t = 1; t <= TICKS; t++) {
      session.tickOnce(intent)
      if (t === CROSS_AT) session.state().karts[0].lap.lap += 1

      // The shell's order, §5.13, minus the DOM and the GPU.
      const view = session.currentView()
      builder.build(0, view)
      buildHudModel(view, RACE_LAPS, hud)
      buildAudioModel(session.prevView(), view, audio)
      // (the shell calls audio.apply(audio) here — cues are consumed NOW)
      for (let c = 0; c < audio.cueCount; c++) {
        const kind = audio.cues[c].kind
        if (kind === 'lapCross') lapCross++
        if (t === 1 && ONE_SHOTS.has(kind)) firstFrameOneShots++
      }
      expect(session.currentView()).not.toBe(session.prevView())
      session.swapViews()
    }

    // Frame 1 compares two PRIMED views, not a real view against a zeroed one.
    expect(firstFrameOneShots).toBe(0)
    // THE assertion. With one shared view, prev IS view, every delta is empty
    // and this is 0. With the swap moved above buildAudioModel, the arguments
    // arrive reversed and the crossing reads as a lap going backwards.
    expect(lapCross).toBe(1)
    expect(hud.lap).toBeGreaterThanOrEqual(1)

    session.close()
  })
})

/**
 * Contract §8.1's "error smoothing, end to end" row, and the only consumer
 * `makeCorrectingGuest` will ever have.
 *
 * Everything else in this plan tests `advanceVisualOffset` in isolation, where
 * the correction is a number a test made up. This drives a REAL guest against a
 * REAL host over the loopback, with a changing intent — which is what actually
 * produces corrections, about three a second, where a held-steady intent
 * produces about one per 600 ticks — and asserts the thing R41 exists for: the
 * drawn kart EASES to the corrected position instead of snapping to it.
 *
 * The drawn position is `view.karts[localPlayerId].position`, which is the only
 * position a player ever sees. Built at `alpha = 0`, the builder's own source
 * for that seat is `prevState()`, so `drawn - prevState` IS the visual offset —
 * measured through the public surface rather than by reaching into the builder.
 */
describe('error smoothing, end to end (§8.1, R41)', () => {
  it('eases a real correction to zero instead of snapping', () => {
    resetBotHold()
    // 180 ticks of sine steering: the fixture's own job, and it returns a guest
    // that has already taken corrections rather than one that might.
    const g = makeCorrectingGuest(180)
    const guest = g.guest
    const localId = guest.localPlayerId
    const builder = createViewBuilder(guest)
    const maxTravelPerTick = guest.ctx.tuning.maxSpeed * TICK_DT

    const hostIntent: Intent = { tick: 0, steer: 0.1, accel: 1, brake: false, drift: false, useItem: false }
    const guestIntent: Intent = { tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false }

    const offsets: number[] = []
    const jumps: number[] = []
    const correctedOnFrame: boolean[] = []
    let corrections = g.corrections()
    let seenCorrections = 0
    let prevDrawn: { x: number; y: number; z: number } | null = null

    // 240 ticks of sine steering, then a quiet tail longer than the ease window
    // with BOTH sides holding the same steady intent. The tail is what makes
    // "eases to zero" observable: corrections all but stop, so the offset has
    // nothing to re-seed it and must decay on its own.
    const SINE_TICKS = 240
    const TAIL_TICKS = ERROR_SMOOTH_WINDOW_TICKS * 4
    for (let t = 181; t <= 180 + SINE_TICKS + TAIL_TICKS; t++) {
      guestIntent.steer = t <= 180 + SINE_TICKS ? Math.sin(t / 12) : 0.1
      g.host.tickOnce(hostIntent)
      guest.tickOnce(guestIntent)
      g.pump(renderNowMs(t, 0))

      const view = guest.currentView()
      builder.build(0, view)

      const drawn = view.karts[localId].position
      const source = guest.prevState().karts[localId].position
      offsets.push(Math.hypot(drawn.x - source.x, drawn.y - source.y, drawn.z - source.z))

      const now = g.corrections()
      correctedOnFrame.push(now > corrections)
      if (now > corrections) seenCorrections++
      corrections = now

      if (prevDrawn !== null) {
        jumps.push(Math.hypot(drawn.x - prevDrawn.x, drawn.y - prevDrawn.y, drawn.z - prevDrawn.z))
      }
      prevDrawn = { x: drawn.x, y: drawn.y, z: drawn.z }
      guest.swapViews()
    }

    // --- vacuity guards, first: a run with nothing to smooth proves nothing ---
    expect(g.corrections()).toBeGreaterThan(0)
    expect(seenCorrections).toBeGreaterThan(0)

    // --- THE assertion, and the one that fails if the smoother is removed -----
    // A no-op `advanceVisualOffset` leaves `current` at the origin forever, the
    // drawn seat is then exactly the raw predicted seat, and EVERY offset here
    // is 0. So this is the assertion that distinguishes "smoothing works" from
    // "smoothing was deleted", which a frame-to-frame bound alone does not:
    // a correction can be small enough to hide under any plausible-travel
    // threshold while still being a visible twitch at 60 Hz.
    const absorbed = offsets.filter((d) => d > 1e-9).length
    expect(absorbed).toBeGreaterThan(0)
    expect(Math.max(...offsets)).toBeGreaterThan(1e-6)

    // --- it EASES: the offset never grows except on a tick that re-seeded it --
    for (let i = 1; i < offsets.length; i++) {
      if (correctedOnFrame[i]) continue // a correction re-seeds the origin, by design
      expect(`frame ${i}: ${offsets[i] <= offsets[i - 1] + 1e-9}`).toBe(`frame ${i}: true`)
    }

    // --- and it reaches zero: the tail is 4x the ease window ------------------
    expect(offsets[offsets.length - 1]).toBeLessThan(1e-6)

    // --- §8.1's own wording: no frame-to-frame jump beyond one tick of travel -
    // The bound is two ticks of top speed, because a boost legitimately exceeds
    // `maxSpeed` for a few ticks; the defect this catches teleports the kart by
    // the whole correction delta in a single frame, which is far larger.
    expect(Math.max(...jumps)).toBeLessThan(maxTravelPerTick * 2)

    g.host.close()
    guest.close()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/game/test/view.test.ts packages/game/test/frameloop.test.ts`

Expected: FAIL at collection with
`Error: Failed to load url ../src/view (resolved id: .../packages/game/src/view) ... Does the file exist?`
— `packages/game/src/view.ts` does not exist yet.

- [ ] **Step 3a: Write `packages/game/src/vite-env.d.ts`**

```ts
/// <reference types="vite/client" />
```

That single line is the whole file, and it is the only place `packages/game`
references Vite's types. It is what makes `import.meta.env.DEV` compile under
`tsc --noEmit`, and it costs `vite` as a devDependency of `packages/game`
(§10 — already declared in that package's manifest). It is **not** needed by
`packages/content`, which uses no Vite feature at all.

- [ ] **Step 3b: Write `packages/game/src/view.ts`**

```ts
// PURE — the one place prediction and interpolation are chosen between (§5.11).
// No DOM, no wall clock, no `three`, no allocation in the frame path.
import type { SimContext, SimState, Vec3 } from '@tapkart/sim'
import {
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  allocStateLike,
  computePlacement,
  driftTierFor,
  itemBoxWorldPos,
  wrapAngle,
} from '@tapkart/sim'
import type { RaceView, VisualOffset } from '@tapkart/render'
import { advanceVisualOffset, createVisualOffset, viewSourceViolations } from '@tapkart/render'
import { renderNowMs } from './clock'
import type { RaceSession } from './session'

export interface ViewBuilder {
  /** Fills `out` from the session captured at construction, obeying §7.1 seat by
   *  seat. SOLE WRITER of every RaceView field. Allocates nothing.
   *  This is the highest-value pure function in packages/game and it is tested
   *  against every role. */
  build(alpha: number, out: RaceView): void
}

/** Fractional part in [0, 1). The `>= 1` guard exists because
 *  `x - Math.floor(x)` can round up to exactly 1 for x just under an integer. */
function wrap01(v: number): number {
  const f = v - Math.floor(v)
  return f >= 1 ? 0 : f
}

/** Shortest-arc angular lerp. A component-wise lerp of two headings either side
 *  of ±π sends the kart the long way round through the opposite bearing. */
function lerpAngle(a: number, b: number, t: number): number {
  return wrapAngle(a + wrapAngle(b - a) * t)
}

/** §5.11 step 5. `s` is arc-normalised [0, 1), never metres. This works on a
 *  guest because `checkpointIdx` and `t` are on the wire, and it costs no
 *  `project()` call in the frame path. `checkpointIdx < 0` is the grid, which
 *  sits behind checkpoint 0 — i.e. on the LAST checkpoint of the notional
 *  previous lap, exactly as `createState` writes it. */
function sFromCheckpoint(cp: readonly number[], checkpointIdx: number, t: number): number {
  const n = cp.length
  if (n === 0) return 0
  const i = checkpointIdx < 0 ? n - 1 : ((checkpointIdx % n) + n) % n
  const span = (cp[(i + 1) % n] - cp[i] + 1) % 1
  return wrap01(cp[i] + t * span)
}

class ViewBuilderImpl implements ViewBuilder {
  private readonly session: RaceSession
  private readonly ctx: SimContext
  /** §5.11 step 9: filled with the VIEW's own kart values and handed to sim's
   *  own comparator, so a guest's placement is computed by the same function the
   *  authority uses, over authoritative wire values. Nothing re-implements it. */
  private readonly scratchState: SimState
  private readonly indexOf = new Int32Array(MAX_KARTS)
  private readonly order = new Int32Array(MAX_KARTS)
  private readonly entityIds = new Int32Array(MAX_ENTITIES)
  private readonly offset: VisualOffset = createVisualOffset()
  private readonly correctionPos: Vec3 = { x: 0, y: 0, z: 0 }
  private lastSeenTick: number

  constructor(session: RaceSession) {
    this.session = session
    this.ctx = session.ctx
    this.scratchState = allocStateLike(session.ctx, session.state())
    this.lastSeenTick = session.state().tick
  }

  build(alpha: number, out: RaceView): void {
    const session = this.session
    const ctx = this.ctx
    const state = session.state()
    const prev = session.prevState()
    const role = session.role
    const isGuest = role === 'guest'
    const localId = session.localPlayerId
    // Step 1. §6.3: nowMs is computed HERE and is never a parameter. The
    // interpolator's keyframes are stamped `tick * TICK_MS`, so a wall clock
    // would put the target instant thousands of milliseconds past the newest
    // keyframe on the very first frame — every remote kart takes the
    // extrapolation branch, clamps, and slides 200 ms along its last velocity
    // forever. Nothing throws and nothing logs; it merely looks wrong on a
    // device, which is the one place CI cannot see.
    const nowMs = renderNowMs(state.tick, alpha)
    const cp = ctx.track.checkpointS

    // --- Steps 2-8: karts, seat by seat, in seat order -----------------------
    for (let i = 0; i < MAX_KARTS; i++) {
      const kv = out.karts[i]
      kv.playerId = i
      // Step 4: from the session in EVERY role. WireKart carries no
      // characterIdx, and ClientLoop's predicted state is all zeroes.
      kv.characterIdx = session.characterIdx[i]

      if (!isGuest || i === localId) {
        const k = state.karts[i]
        const p = prev.karts[i]
        kv.source = isGuest ? 'predicted' : 'authoritative'
        // Step 3: state-sourced seats are lerped by alpha. Render-only — it
        // writes into the view, never back into either SimState.
        kv.position.x = p.position.x + (k.position.x - p.position.x) * alpha
        kv.position.y = p.position.y + (k.position.y - p.position.y) * alpha
        kv.position.z = p.position.z + (k.position.z - p.position.z) * alpha
        kv.heading = lerpAngle(p.heading, k.heading, alpha)
        kv.velocity.x = k.velocity.x
        kv.velocity.y = k.velocity.y
        kv.velocity.z = k.velocity.z
        kv.angularVelocity = k.angularVelocity
        kv.driftActive = k.drift.active
        kv.driftDir = k.drift.dir
        kv.driftCharge = k.drift.charge
        kv.airborne = k.airborne
        kv.surface = k.surface
        kv.spinOutTicks = k.spinOutTicks
        kv.invulnTicks = k.invulnTicks
        kv.boostTicks = k.boostTicks
        kv.respawnTicks = k.respawnTicks
        kv.shielded = k.shielded
        kv.item = k.item
        kv.lap = k.lap.lap
        kv.checkpointIdx = k.lap.checkpointIdx
        kv.t = k.lap.t
        kv.isBot = k.isBot
        kv.connected = k.connected
      } else {
        const sample = session.sampleRemoteKart(i, nowMs)
        if (sample === null) {
          // A cold or starved buffer. Everything else on this seat keeps its
          // previous value; `source` is the only field that changes, and
          // `visible` falls out of it in buildRenderFrame.
          kv.source = 'absent'
          continue
        }
        const w = sample.kart
        kv.source = 'interpolated'
        // Only position and heading come from the interpolation itself…
        kv.position.x = sample.position.x
        kv.position.y = sample.position.y
        kv.position.z = sample.position.z
        kv.heading = wrapAngle(sample.heading)
        // …and EVERY discrete field comes from the wire record, verbatim (Q5).
        // Nothing is mixed: a KartView is filled from exactly one source.
        kv.velocity.x = w.velocity.x
        kv.velocity.y = w.velocity.y
        kv.velocity.z = w.velocity.z
        kv.angularVelocity = w.angularVelocity
        kv.driftActive = w.driftActive
        kv.driftDir = w.driftDir
        kv.driftCharge = w.driftCharge
        kv.airborne = w.airborne
        kv.surface = w.surface
        kv.spinOutTicks = w.spinOutTicks
        kv.invulnTicks = w.invulnTicks
        kv.boostTicks = w.boostTicks
        kv.respawnTicks = w.respawnTicks
        kv.shielded = w.shielded
        kv.item = w.item
        kv.lap = w.lap
        kv.checkpointIdx = w.checkpointIdx
        kv.t = w.t
        kv.isBot = w.isBot
        kv.connected = w.connected
      }

      kv.speed = Math.hypot(kv.velocity.x, kv.velocity.z) // step 7, PLAN view
      kv.s = sFromCheckpoint(cp, kv.checkpointIdx, kv.t) // step 5
      // Step 6. sampleAt returns SHARED scratch (§7.3) — this reads one number
      // out of it immediately and retains nothing.
      kv.bankAngle = ctx.query.sampleAt(kv.s).banking
      // Step 8: the only call site of driftTierFor in Plan 3, and the only place
      // the tier is computed. sim's encoding: -1 none, 0..2 an index.
      kv.driftTier = driftTierFor(kv.driftCharge, ctx.tuning.driftTiers)
    }

    // --- Step 11a: error smoothing, local seat, guest only (R41/R47/R48) -----
    if (isGuest && localId >= 0 && localId < MAX_KARTS) {
      const ticksElapsed = state.tick - this.lastSeenTick
      if (ticksElapsed > 0) {
        this.lastSeenTick = state.tick
        // The nullable travels UNCHANGED from correctionDeltaOf through the
        // session into the smoother, so "no correction" is never reconstructed
        // from a zero delta.
        const h = session.correctionDelta(this.correctionPos)
        advanceVisualOffset(this.offset, this.correctionPos, h, ticksElapsed, this.offset)
      }
      // Applied every frame, including frames that ran zero ticks — that is what
      // keeps the ease frame-rate independent. Never written into a SimState,
      // never applied to a remote seat, never on host or solo.
      const kv = out.karts[localId]
      const o = this.offset
      kv.position.x += o.current.x
      kv.position.y += o.current.y
      kv.position.z += o.current.z
      kv.heading = wrapAngle(kv.heading + o.currentHeading)
    }

    // --- Step 9: placement, always through sim's own comparator --------------
    const sk = this.scratchState
    for (let i = 0; i < MAX_KARTS; i++) {
      const kv = out.karts[i]
      const k = sk.karts[i]
      k.playerId = i
      k.lap.lap = kv.lap
      k.lap.checkpointIdx = kv.checkpointIdx
      k.lap.t = kv.t
    }
    for (let i = 0; i < MAX_KARTS; i++) sk.finishedOrder[i] = state.finishedOrder[i]
    computePlacement(sk, this.indexOf, this.order)
    for (let i = 0; i < MAX_KARTS; i++) out.karts[i].place = this.indexOf[i]

    // --- Step 10: entities ---------------------------------------------------
    if (isGuest) {
      const n = session.remoteEntityIds(this.entityIds)
      let live = 0
      for (let j = 0; j < n && live < MAX_ENTITIES; j++) {
        const id = this.entityIds[j]
        const sample = session.sampleRemoteEntity(id, nowMs)
        if (sample === null) continue // despawned between keyframes: not listed
        const e = sample.entity
        const ev = out.entities[live]
        live++
        ev.entityId = e.entityId
        ev.kind = e.kind
        ev.ownerId = e.ownerId
        ev.source = 'interpolated'
        ev.position.x = sample.position.x
        ev.position.y = sample.position.y
        ev.position.z = sample.position.z
        ev.heading = wrapAngle(sample.heading)
        ev.velocity.x = e.velocity.x
        ev.velocity.y = e.velocity.y
        ev.velocity.z = e.velocity.z
        ev.ttl = e.ttl
      }
      out.entityCount = live
      for (let j = live; j < MAX_ENTITIES; j++) {
        out.entities[j].entityId = -1
        out.entities[j].source = 'absent'
      }
    } else {
      const count = state.entityCount
      for (let j = 0; j < MAX_ENTITIES; j++) {
        const ev = out.entities[j]
        if (j >= count) {
          ev.entityId = -1
          ev.source = 'absent'
          continue
        }
        const e = state.entities[j]
        const pe = prev.entities[j]
        ev.entityId = e.entityId
        ev.kind = e.kind
        ev.ownerId = e.ownerId
        ev.source = 'authoritative'
        // Lerped by alpha like karts — but ONLY against the same entity. Slots
        // are packed and reused by swap-remove, so a slot's previous occupant is
        // frequently a different entity somewhere else on the track, and lerping
        // against it would fly the new one in from there.
        const same = pe.entityId === e.entityId
        ev.position.x = same ? pe.position.x + (e.position.x - pe.position.x) * alpha : e.position.x
        ev.position.y = same ? pe.position.y + (e.position.y - pe.position.y) * alpha : e.position.y
        ev.position.z = same ? pe.position.z + (e.position.z - pe.position.z) * alpha : e.position.z
        ev.heading = same ? lerpAngle(pe.heading, e.heading, alpha) : e.heading
        ev.velocity.x = e.velocity.x
        ev.velocity.y = e.velocity.y
        ev.velocity.z = e.velocity.z
        ev.ttl = e.ttl
      }
      out.entityCount = count
    }

    // --- Step 11: item boxes, from state() in every role ---------------------
    // No `source` field and nothing polices these: WireSnapshot carries no
    // item-box state at all, so a guest has no authoritative source to check
    // against. A wrong box is a cosmetic ghost, and every real pickup is
    // corrected by the reliable itemGrant stream (§7.1, R45).
    const boxes = out.itemBoxes
    for (let b = 0; b < boxes.length; b++) {
      const bx = boxes[b]
      bx.boxIdx = b
      // The drawn box and the pickup volume are one object, by construction.
      // This also invalidates the query scratch, which is why bankAngle above
      // was copied out immediately.
      itemBoxWorldPos(ctx, b, bx.position)
      bx.respawnTicks = state.itemBoxes[b].respawnTicks
    }
    out.itemBoxRespawnTicks = ctx.tuning.itemBoxRespawnTicks

    // --- Step 12: scalars ----------------------------------------------------
    out.tick = state.tick
    out.alpha = alpha
    out.phase = state.phase // authoritative in every role now that R44 wires it
    out.localPlayerId = localId
    out.raceStartTick = session.raceStartTick
    out.finishTick = state.finishTick
    for (let i = 0; i < MAX_KARTS; i++) out.finishedOrder[i] = state.finishedOrder[i]
    out.countdownTicksLeft =
      state.phase === 'countdown' ? Math.max(0, COUNTDOWN_TICKS - state.tick) : 0

    // --- Step 13: Q32's dev assertion, last ----------------------------------
    if (import.meta.env.DEV) {
      const violations = viewSourceViolations(out, role)
      if (violations.length > 0) {
        throw new Error(`buildRaceView: seat-source violations:\n${violations.join('\n')}`)
      }
    }
  }
}

/**
 * Allocates the builder's scratch ONCE: the placement scratch SimState, two
 * Int32Arrays for computePlacement, the Int32Array remoteEntityIds fills, one
 * VisualOffset (R41) and one Vec3 for the correction delta.
 *
 * It also PRIMES both of the session's RaceViews (§5.10). `buildAudioModel`
 * takes the delta between consecutive views; if frame 1 compared a real view
 * against a freshly zeroed one it would fire a burst of spurious cues on the
 * grid. Priming lives here because this is the only thing in the repository that
 * can fill a view, and leaving it to the shell would make it forgettable.
 */
export function createViewBuilder(session: RaceSession): ViewBuilder {
  const builder = new ViewBuilderImpl(session)
  builder.build(0, session.currentView())
  session.swapViews()
  builder.build(0, session.currentView())
  return builder
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/game/test/view.test.ts packages/game/test/frameloop.test.ts`
Expected: 12 passing.

The smoothing test drives 480 sim ticks on two sessions plus a 48-tick tail, so
it is the slowest test in the file at roughly a second. If it fails on
`expect(seenCorrections).toBeGreaterThan(0)`, the loopback pair is delivering
nothing — check the fixture's transport before suspecting the smoother.

Then typecheck: `npx tsc --noEmit -p packages/game/tsconfig.json` — expected: no
output. If it reports *"Cannot find type definition file for 'vite/client'"*, run
`npm install` at the repository root: `vite` is a declared devDependency of
`packages/game` (§10) and the reference in `vite-env.d.ts` needs it on disk.

**What each test catches, and whether it would actually fail under that bug:**

| Test | Bug | Fails? |
|---|---|---|
| flagship, 600 ticks | any seat or entity drawn from the wrong source in any role | yes — and the two "saw ≥ 1 interpolated" guards mean an all-`'absent'` view cannot pass, which is the way this test would otherwise measure nothing |
| remote seat from the wire | the naive implementation: filling remote seats from `state()`, i.e. from the local sim's bot AI | yes — the two sources are made **provably different** first (500 m, lap 7, charge 999, item `'bolt'`), so a pass cannot come from the two happening to agree |
| local seat still from state | over-correcting into "read everything from the interpolator" | yes — the interpolator returns `null` for the local seat, so the seat would go `'absent'` and never move |
| tick-derived nowMs | passing `clock.nowMs()` to the interpolator (§6.3) | yes — the test first proves the wrong basis pins two instants a minute apart to the same pose, then asserts the view matches the right basis and not that one |
| DEV assertion throws | the assertion omitted, or wrapped so it can never fire | yes |
| Q9 lerp on a bot seat | lerping only the local seat, the literal reading of Q9 | yes — seat 5 would equal the current value; the `> 1e-6` guard first proves prev and cur genuinely differ |
| shortest-arc heading | a component-wise heading lerp | yes — gives 0 instead of ±π, a difference of the whole circle |
| entity slot reuse | lerping a slot against whatever used to live in it | yes — 900 m of error |
| characterIdx from session | reading it off `state()` | yes — `state()` says 0, the session says 3 |
| s reconstruction | using metres instead of arc-normalised `s`, or mishandling `checkpointIdx < 0` | yes |
| placement from view values | computing placement from `state()` on a guest | yes — `state()` claims every remote seat is on lap 9, so seat 0 would not be first |
| entity packing | listing an unsampled id, or leaving a stale `entityId` in a dead slot | yes, and `viewSourceViolations` agrees independently |
| scalars / no allocation | rebuilding the view's objects per frame | yes — object identity |
| **frameloop: exactly one lapCross** | **the contract defect: one shared `RaceView`, so `prev` IS `view` and every audio delta is empty** | **yes — the count is 0.** It also fails if the swap is moved above `buildAudioModel` (arguments reversed) or if the views are not primed (frame 1 fires a burst) |
| **frameloop: error smoothing, end to end** | **R41 removed, stubbed, or applied to a `SimState` instead of the drawn seat** — the required feature that every unit-level test around it would still pass without | **yes — with a no-op smoother the drawn seat IS the raw predicted seat, every measured offset is exactly 0, and `absorbed > 0` fails.** It also fails if the offset never decays (a smoother that re-seeds every frame: the monotone check trips), if it never reaches zero (the tail is four ease windows long), and if the ease is applied per FRAME rather than per TICK. The two vacuity guards come first, because a run with zero corrections would let a deleted smoother pass everything below them |

- [ ] **Step 5: Commit**

```bash
git add packages/game/src/view.ts packages/game/src/vite-env.d.ts \
        packages/game/test/view.test.ts packages/game/test/frameloop.test.ts && \
git commit -m "feat(game): ViewBuilder — the seat-source rule, made mechanical

frameloop.test.ts also carries §8.1's error-smoothing row: a real guest
taking real corrections over the loopback, with the drawn local position
recorded every frame. It asserts the offset is non-zero (a deleted
smoother makes every one of them exactly 0), decays monotonically except
on the ticks that re-seed it, reaches zero within the ease window, and
never moves the drawn kart further in one frame than a kart can travel
in one tick. makeCorrectingGuest exists for this test and has no other
consumer: a held-steady intent produces about one correction per 600
ticks, so a smoothing test driven by one would have nothing to smooth."
```
