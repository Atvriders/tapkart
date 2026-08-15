import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent, SimState, Vec3 } from '@tapkart/sim'
import {
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  allocStateLike,
  cloneState,
  createState,
  spawnEntity,
  wrapAngle,
} from '@tapkart/sim'
import type { WireEntity, WireKart } from '@tapkart/protocol'
import { makeRemoteSample } from '@tapkart/net'
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
  return createSession({
    role: 'solo',
    ctx: makeGameContext(true),
    localPlayerId,
    seed: 0x5eed,
    characterIdx: CHARACTER_IDX.slice(),
    transport: createSoloTransport(),
  })
}

interface FakeOpts {
  localPlayerId: number
  wireKart?: (playerId: number) => WireKart | null
  entityIds?: readonly number[]
  wireEntity?: (entityId: number) => WireEntity | null
  correctionDelta?: (outPos: Vec3) => number | null
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

/** A hand-built guest whose prediction and authoritative wire data can differ. */
function makeFakeGuest(opts: FakeOpts): RaceSession {
  const ctx = makeGameContext(false)
  const state: SimState = createState(ctx, 0, [0, 0, 0, 0, 0, 0, 0, 0])
  state.phase = 'racing'
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
    sampleRemoteKart: (playerId, _nowMs, out) => {
      if (playerId === opts.localPlayerId) return false
      const kart = opts.wireKart === undefined ? null : opts.wireKart(playerId)
      if (kart === null) return false
      out.position.x = kart.position.x
      out.position.y = kart.position.y
      out.position.z = kart.position.z
      out.heading = kart.heading
      out.kart = kart
      return true
    },
    sampleRemoteEntity: (entityId, _nowMs, out) => {
      const entity = opts.wireEntity === undefined ? null : opts.wireEntity(entityId)
      if (entity === null) return false
      out.position.x = entity.position.x
      out.position.y = entity.position.y
      out.position.z = entity.position.z
      out.heading = entity.heading
      out.entity = entity
      return true
    },
    remoteEntityIds: (out) => {
      const ids = opts.entityIds ?? []
      for (let i = 0; i < ids.length; i++) out[i] = ids[i]
      return ids.length
    },
    corrections: () => 0,
    correctionDelta:
      opts.correctionDelta ??
      ((outPos: Vec3) => {
        outPos.x = 0
        outPos.y = 0
        outPos.z = 0
        return null
      }),
    currentView: () => a,
    prevView: () => b,
    swapViews: () => {
      const current = a
      a = b
      b = current
    },
    close: () => undefined,
  }
}

describe('the seat-source rule (§7.1) — the flagship', () => {
  it('a real guest sees no violations over 600 ticks, and really does interpolate', () => {
    const pair = makeSessionPair()
    const owner = pair.host.state().karts[3]
    const spawnEvents: AuthEvent[] = []
    spawnEntity(
      pair.host.ctx,
      pair.host.state(),
      'slick',
      3,
      { x: owner.position.x + 2, y: owner.position.y, z: owner.position.z + 2 },
      0,
      -1,
      600,
      spawnEvents,
    )

    const guestBuilder = createViewBuilder(pair.guest)
    const hostBuilder = createViewBuilder(pair.host)
    const it = intent(0.3, 1)
    let sawInterpolatedSeat = 0
    let sawInterpolatedEntity = 0
    let violations = 0

    for (let tick = 1; tick <= 600; tick++) {
      pair.host.tickOnce(it)
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(tick, 0))

      const guestView = pair.guest.currentView()
      guestBuilder.build(0.5, guestView)
      violations += viewSourceViolations(guestView, 'guest').length
      for (let i = 0; i < MAX_KARTS; i++) {
        if (guestView.karts[i].source === 'interpolated') sawInterpolatedSeat++
      }
      for (let j = 0; j < guestView.entityCount; j++) {
        if (guestView.entities[j].source === 'interpolated') sawInterpolatedEntity++
      }
      pair.guest.swapViews()

      const hostView = pair.host.currentView()
      hostBuilder.build(0.5, hostView)
      violations += viewSourceViolations(hostView, 'host').length
      pair.host.swapViews()
    }

    expect(violations).toBe(0)
    expect(sawInterpolatedSeat).toBeGreaterThan(0)
    expect(sawInterpolatedEntity).toBeGreaterThan(0)
    pair.host.close()
    pair.guest.close()
  })

  it('reads a remote seat from the wire even when the prediction says otherwise', () => {
    const pair = makeSessionPair()
    const builder = createViewBuilder(pair.guest)
    const it = intent(0.2, 1)
    for (let tick = 1; tick <= 300; tick++) {
      pair.host.tickOnce(it)
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(tick, 0))
    }

    const fiction = pair.guest.state().karts[2]
    fiction.position.x += 500
    fiction.lap.lap = 7
    fiction.drift.charge = 999
    fiction.shielded = true
    fiction.item = 'bolt'

    const now = renderNowMs(pair.guest.state().tick, 0.5)
    const wire = makeRemoteSample()
    expect(pair.guest.sampleRemoteKart(2, now, wire)).toBe(true)
    expect(wire.kart.lap).not.toBe(7)
    const wireLap = wire.kart.lap
    const wireDriftCharge = wire.kart.driftCharge
    const wireShielded = wire.kart.shielded
    const wireItem = wire.kart.item
    const wirePosX = wire.position.x

    const view = pair.guest.currentView()
    builder.build(0.5, view)
    const seat = view.karts[2]
    expect(seat.source).toBe('interpolated')
    expect(seat.lap).toBe(wireLap)
    expect(seat.driftCharge).toBe(wireDriftCharge)
    expect(seat.shielded).toBe(wireShielded)
    expect(seat.item).toBe(wireItem)
    expect(seat.position.x).toBeCloseTo(wirePosX, 9)
    expect(Math.abs(seat.position.x - fiction.position.x)).toBeGreaterThan(100)

    const before = view.karts[1].position.x
    pair.guest.state().karts[1].position.x += 500
    builder.build(0.5, view)
    expect(view.karts[1].source).toBe('predicted')
    expect(view.karts[1].position.x - before).toBeGreaterThan(100)
    pair.host.close()
    pair.guest.close()
  })

  it('passes the interpolator a tick-derived nowMs, not a wall clock (§6.3)', () => {
    const pair = makeSessionPair()
    const builder = createViewBuilder(pair.guest)
    const it = intent(0.2, 1)
    for (let tick = 1; tick <= 300; tick++) {
      pair.host.tickOnce(it)
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(tick, 0))
    }

    const alpha = 0.5
    const tickNow = renderNowMs(pair.guest.state().tick, alpha)
    const wallish = 3_600_000
    const buffer = makeRemoteSample()
    expect(pair.guest.sampleRemoteKart(2, tickNow, buffer)).toBe(true)
    const correctX = buffer.position.x
    expect(pair.guest.sampleRemoteKart(2, wallish, buffer)).toBe(true)
    const pinnedAX = buffer.position.x
    expect(pair.guest.sampleRemoteKart(2, wallish + 60_000, buffer)).toBe(true)
    const pinnedBX = buffer.position.x

    expect(pinnedAX).toBeCloseTo(pinnedBX, 9)
    expect(Math.abs(correctX - pinnedAX)).toBeGreaterThan(0.01)

    const view = pair.guest.currentView()
    builder.build(alpha, view)
    expect(view.karts[2].position.x).toBeCloseTo(correctX, 9)
    pair.host.close()
    pair.guest.close()
  })

  it('throws in a DEV build when a view violates the rule (Q32)', () => {
    const fake = makeFakeGuest({ localPlayerId: -1 })
    const valid = createViewBuilder(makeFakeGuest({ localPlayerId: 1 }))
    expect(valid).toBeDefined()
    expect(() => createViewBuilder(fake)).toThrow(/seat-source violations/)
  })
})

describe("Q9's alpha lerp", () => {
  it('applies to EVERY state-sourced seat, not only the local one (§15.3)', () => {
    const session = makeSolo(0)
    const builder = createViewBuilder(session)
    const it = intent(0.4, 1)
    for (let tick = 0; tick < COUNTDOWN_TICKS + 40; tick++) session.tickOnce(it)

    const seat = 5
    const previous = session.prevState().karts[seat].position.x
    const current = session.state().karts[seat].position.x
    expect(Math.abs(current - previous)).toBeGreaterThan(1e-6)

    const view = session.currentView()
    builder.build(0.25, view)
    expect(view.karts[seat].position.x).toBeCloseTo(previous + (current - previous) * 0.25, 12)
    expect(view.karts[seat].source).toBe('authoritative')
    session.close()
  })

  it('lerps heading the short way round', () => {
    const session = makeSolo(0)
    const builder = createViewBuilder(session)
    session.tickOnce(intent(0, 0))
    session.prevState().karts[2].heading = 3
    session.state().karts[2].heading = -3

    const view = session.currentView()
    builder.build(0.5, view)
    expect(Math.abs(view.karts[2].heading)).toBeCloseTo(Math.PI, 6)
    expect(Math.abs(wrapAngle(view.karts[2].heading))).toBeGreaterThan(3)
    session.close()
  })

  it('does not lerp an entity slot against a different entity', () => {
    const session = makeSolo(0)
    const builder = createViewBuilder(session)
    const kart = session.state().karts[0]
    spawnEntity(
      session.ctx,
      session.state(),
      'slick',
      0,
      { x: kart.position.x, y: kart.position.y, z: kart.position.z },
      0,
      -1,
      600,
      [],
    )
    session.tickOnce(intent(0, 0))

    const current = session.state().entities[0]
    const previous = session.prevState().entities[0]
    previous.entityId = current.entityId + 77
    previous.position.x = current.position.x + 900

    const view = session.currentView()
    builder.build(0.5, view)
    expect(view.entityCount).toBeGreaterThan(0)
    expect(view.entities[0].entityId).toBe(current.entityId)
    expect(view.entities[0].position.x).toBeCloseTo(current.position.x, 12)

    previous.entityId = current.entityId
    builder.build(0.5, view)
    expect(view.entities[0].position.x).toBeCloseTo(current.position.x + 450, 9)
    session.close()
  })
})

describe('guest correction smoothing', () => {
  it('inverts net post-minus-pre deltas instead of doubling the discontinuity', () => {
    let pending = true
    const fake = makeFakeGuest({
      localPlayerId: 1,
      correctionDelta: (outPos) => {
        if (!pending) return null
        pending = false
        outPos.x = 2
        outPos.y = 0
        outPos.z = 0
        return 0.1
      },
    })
    const builder = createViewBuilder(fake)

    // A +2/+0.1 net delta moves the state from 8/0 to 10/0.1. The inverse is
    // ramped with alpha on this tick, so every point on the raw correction lerp
    // stays at the old visual pose. Passing the delta through would instead
    // produce 8, 10, 12 across these three samples and double the jump.
    const stateKart = fake.state().karts[1]
    const previousKart = fake.prevState().karts[1]
    stateKart.position.x = 10
    previousKart.position.x = 8
    stateKart.heading = 0.1
    previousKart.heading = 0
    fake.state().tick = 1

    const view = fake.currentView()
    builder.build(0, view)
    expect(view.karts[1].position.x).toBeCloseTo(8, 12)
    expect(view.karts[1].heading).toBeCloseTo(0, 12)
    builder.build(0.5, view)
    expect(view.karts[1].position.x).toBeCloseTo(8, 12)
    expect(view.karts[1].heading).toBeCloseTo(0, 12)
    builder.build(1, view)
    expect(view.karts[1].position.x).toBeCloseTo(8, 12)
    expect(view.karts[1].heading).toBeCloseTo(0, 12)
  })
})

describe('derived fields', () => {
  it('takes characterIdx from the session, never from state (§2.3 fact 1)', () => {
    const pair = makeSessionPair()
    const builder = createViewBuilder(pair.guest)
    const view = pair.guest.currentView()
    builder.build(0, view)
    expect(pair.guest.state().karts[3].characterIdx).toBe(0)
    expect(view.karts[3].characterIdx).toBe(pair.guest.characterIdx[3])
    expect(view.karts[3].characterIdx).toBe(3)
    pair.host.close()
    pair.guest.close()
  })

  it('reconstructs s from checkpointIdx and t, with the grid on the last checkpoint', () => {
    const session = makeSolo(0)
    const builder = createViewBuilder(session)
    const checkpoints = session.ctx.track.checkpointS
    const count = checkpoints.length
    expect(count).toBeGreaterThan(1)

    const wrap01 = (value: number): number => value - Math.floor(value)
    const segment = (index: number): number =>
      (checkpoints[(index + 1) % count] - checkpoints[index] + 1) % 1

    for (const kart of [session.state().karts[4], session.prevState().karts[4]]) {
      kart.lap.checkpointIdx = 0
      kart.lap.t = 0.5
    }
    const view = session.currentView()
    builder.build(0, view)
    expect(view.karts[4].s).toBeCloseTo(wrap01(checkpoints[0] + 0.5 * segment(0)), 12)

    for (const kart of [session.state().karts[4], session.prevState().karts[4]]) {
      kart.lap.checkpointIdx = -1
      kart.lap.t = 0
    }
    builder.build(0, view)
    expect(view.karts[4].s).toBeCloseTo(wrap01(checkpoints[count - 1]), 12)
    session.close()
  })

  it("computes place with computePlacement over the view's own values", () => {
    const laps: Record<number, number | undefined> = { 0: 2, 2: 1 }
    const fake = makeFakeGuest({
      localPlayerId: 1,
      wireKart: (playerId) => makeWireKart(playerId, laps[playerId] ?? 0, 0.1 + playerId * 0.01),
    })
    const builder = createViewBuilder(fake)
    const view = fake.currentView()
    builder.build(0, view)

    expect(view.karts[0].lap).toBe(2)
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
      wireKart: (playerId) => makeWireKart(playerId, 0, 0.1),
      entityIds: [7, 9],
      wireEntity: (entityId) => (entityId === 7 ? wire : null),
    })
    const builder = createViewBuilder(fake)
    const view = fake.currentView()
    builder.build(0, view)

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
    const session = makeSolo(0)
    const builder = createViewBuilder(session)
    const view = session.currentView()
    const positionIdentity = view.karts[0].position
    const boxIdentity = view.itemBoxes[0].position

    session.tickOnce(intent(0, 1))
    builder.build(0.25, view)

    expect(view.tick).toBe(session.state().tick)
    expect(view.alpha).toBe(0.25)
    expect(view.phase).toBe('countdown')
    expect(view.localPlayerId).toBe(0)
    expect(view.raceStartTick).toBe(COUNTDOWN_TICKS)
    expect(view.countdownTicksLeft).toBe(COUNTDOWN_TICKS - session.state().tick)
    expect(view.finishTick).toBe(-1)
    expect(view.itemBoxRespawnTicks).toBe(session.ctx.tuning.itemBoxRespawnTicks)
    expect(view.itemBoxes.length).toBe(session.ctx.track.itemBoxes.length)
    expect(view.karts[0].position).toBe(positionIdentity)
    expect(view.itemBoxes[0].position).toBe(boxIdentity)
    session.close()
  })
})
