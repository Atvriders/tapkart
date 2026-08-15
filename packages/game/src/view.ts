// PURE — the one place prediction and interpolation are chosen between.
// No DOM, wall clock, `three`, or allocation in the production frame path.
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
import type { RemoteEntitySample, RemoteSample } from '@tapkart/net'
import { makeRemoteEntitySample, makeRemoteSample } from '@tapkart/net'
import type { RaceView, VisualOffset } from '@tapkart/render'
import { advanceVisualOffset, createVisualOffset, viewSourceViolations } from '@tapkart/render'
import { renderNowMs } from './clock'
import type { RaceSession } from './session'

export interface ViewBuilder {
  /** Sole writer of every RaceView field. */
  build(alpha: number, out: RaceView): void
}

function wrap01(value: number): number {
  const fraction = value - Math.floor(value)
  return fraction >= 1 ? 0 : fraction
}

function lerpAngle(previous: number, current: number, alpha: number): number {
  return wrapAngle(previous + wrapAngle(current - previous) * alpha)
}

/** Reconstruct arc-normalised track progress from wire-compatible lap fields. */
function sFromCheckpoint(
  checkpoints: readonly number[],
  checkpointIdx: number,
  progress: number,
): number {
  const count = checkpoints.length
  if (count === 0) return 0
  const index = checkpointIdx < 0 ? count - 1 : ((checkpointIdx % count) + count) % count
  const span = (checkpoints[(index + 1) % count] - checkpoints[index] + 1) % 1
  return wrap01(checkpoints[index] + progress * span)
}

class ViewBuilderImpl implements ViewBuilder {
  private readonly session: RaceSession
  private readonly ctx: SimContext
  private readonly scratchState: SimState
  private readonly indexOf = new Int32Array(MAX_KARTS)
  private readonly order = new Int32Array(MAX_KARTS)
  private readonly entityIds = new Int32Array(MAX_ENTITIES)
  private readonly offset: VisualOffset = createVisualOffset()
  private readonly offsetFrom: Vec3 = { x: 0, y: 0, z: 0 }
  private offsetHeadingFrom = 0
  private readonly correctionPos: Vec3 = { x: 0, y: 0, z: 0 }

  // P2-R29: ViewBuilder is the sampler caller and owns exactly one buffer of
  // each shape. Every successful sample is copied before this scratch is reused.
  private readonly kartSample: RemoteSample = makeRemoteSample()
  private readonly entitySample: RemoteEntitySample = makeRemoteEntitySample()
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
    const previous = session.prevState()
    const role = session.role
    const isGuest = role === 'guest'
    const localId = session.localPlayerId
    const nowMs = renderNowMs(state.tick, alpha)
    const checkpoints = ctx.track.checkpointS

    for (let index = 0; index < MAX_KARTS; index++) {
      const view = out.karts[index]
      view.playerId = index
      view.characterIdx = session.characterIdx[index]

      if (!isGuest || index === localId) {
        const kart = state.karts[index]
        const previousKart = previous.karts[index]
        view.source = isGuest ? 'predicted' : 'authoritative'
        view.position.x =
          previousKart.position.x + (kart.position.x - previousKart.position.x) * alpha
        view.position.y =
          previousKart.position.y + (kart.position.y - previousKart.position.y) * alpha
        view.position.z =
          previousKart.position.z + (kart.position.z - previousKart.position.z) * alpha
        view.heading = lerpAngle(previousKart.heading, kart.heading, alpha)
        view.velocity.x = kart.velocity.x
        view.velocity.y = kart.velocity.y
        view.velocity.z = kart.velocity.z
        view.angularVelocity = kart.angularVelocity
        view.driftActive = kart.drift.active
        view.driftDir = kart.drift.dir
        view.driftCharge = kart.drift.charge
        view.airborne = kart.airborne
        view.surface = kart.surface
        view.spinOutTicks = kart.spinOutTicks
        view.invulnTicks = kart.invulnTicks
        view.boostTicks = kart.boostTicks
        view.respawnTicks = kart.respawnTicks
        view.shielded = kart.shielded
        view.item = kart.item
        view.lap = kart.lap.lap
        view.checkpointIdx = kart.lap.checkpointIdx
        view.t = kart.lap.t
        view.isBot = kart.isBot
        view.connected = kart.connected
      } else {
        const sample = this.kartSample
        if (!session.sampleRemoteKart(index, nowMs, sample)) {
          // A false sample leaves this buffer unchanged. Mark the seat absent
          // and do not read any stale field from the prior successful sample.
          view.source = 'absent'
          continue
        }

        const wire = sample.kart
        view.source = 'interpolated'
        view.position.x = sample.position.x
        view.position.y = sample.position.y
        view.position.z = sample.position.z
        view.heading = wrapAngle(sample.heading)
        view.velocity.x = wire.velocity.x
        view.velocity.y = wire.velocity.y
        view.velocity.z = wire.velocity.z
        view.angularVelocity = wire.angularVelocity
        view.driftActive = wire.driftActive
        view.driftDir = wire.driftDir
        view.driftCharge = wire.driftCharge
        view.airborne = wire.airborne
        view.surface = wire.surface
        view.spinOutTicks = wire.spinOutTicks
        view.invulnTicks = wire.invulnTicks
        view.boostTicks = wire.boostTicks
        view.respawnTicks = wire.respawnTicks
        view.shielded = wire.shielded
        view.item = wire.item
        view.lap = wire.lap
        view.checkpointIdx = wire.checkpointIdx
        view.t = wire.t
        view.isBot = wire.isBot
        view.connected = wire.connected
      }

      view.speed = Math.hypot(view.velocity.x, view.velocity.z)
      view.s = sFromCheckpoint(checkpoints, view.checkpointIdx, view.t)
      view.bankAngle = ctx.query.sampleAt(view.s).banking
      view.driftTier = driftTierFor(view.driftCharge, ctx.tuning.driftTiers)
    }

    if (isGuest && localId >= 0 && localId < MAX_KARTS) {
      const ticksElapsed = state.tick - this.lastSeenTick
      if (ticksElapsed > 0) {
        this.lastSeenTick = state.tick
        // A render frame describes the interval from the prior sim endpoint to
        // this one. Retain both offset endpoints so alpha interpolates the
        // visual correction over that same interval. This matters both while a
        // correction decays and when a new correction lands before the old
        // residual is gone: alpha 0 must keep the old residual, while alpha 1
        // carries the old residual plus the new inverse in full.
        this.offsetFrom.x = this.offset.current.x
        this.offsetFrom.y = this.offset.current.y
        this.offsetFrom.z = this.offset.current.z
        this.offsetHeadingFrom = this.offset.currentHeading
        const correctionHeading = session.correctionDelta(this.correctionPos)
        if (correctionHeading === null) {
          advanceVisualOffset(this.offset, this.correctionPos, null, ticksElapsed, this.offset)
        } else {
          // RaceSession preserves net's post-reconcile minus pre-reconcile
          // convention. VisualOffset is ADDED to the corrected pose, so its
          // seed is the inverse: old visual minus new state. Passing the net
          // delta through would double the discontinuity instead of hiding it.
          this.correctionPos.x = -this.correctionPos.x
          this.correctionPos.y = -this.correctionPos.y
          this.correctionPos.z = -this.correctionPos.z
          advanceVisualOffset(
            this.offset,
            this.correctionPos,
            -correctionHeading,
            ticksElapsed,
            this.offset,
          )
        }
      }

      const localView = out.karts[localId]
      const offsetX = this.offsetFrom.x + (this.offset.current.x - this.offsetFrom.x) * alpha
      const offsetY = this.offsetFrom.y + (this.offset.current.y - this.offsetFrom.y) * alpha
      const offsetZ = this.offsetFrom.z + (this.offset.current.z - this.offsetFrom.z) * alpha
      const offsetHeading =
        this.offsetHeadingFrom
        + (this.offset.currentHeading - this.offsetHeadingFrom) * alpha
      localView.position.x += offsetX
      localView.position.y += offsetY
      localView.position.z += offsetZ
      localView.heading = wrapAngle(
        localView.heading + offsetHeading,
      )
    }

    // Placement uses the values selected for this view, never guest prediction
    // for remote seats.
    for (let index = 0; index < MAX_KARTS; index++) {
      const source = out.karts[index]
      const target = this.scratchState.karts[index]
      target.playerId = index
      target.lap.lap = source.lap
      target.lap.checkpointIdx = source.checkpointIdx
      target.lap.t = source.t
    }
    for (let index = 0; index < MAX_KARTS; index++) {
      this.scratchState.finishedOrder[index] = state.finishedOrder[index]
    }
    computePlacement(this.scratchState, this.indexOf, this.order)
    for (let index = 0; index < MAX_KARTS; index++) {
      out.karts[index].place = this.indexOf[index]
    }

    if (isGuest) {
      const remoteCount = session.remoteEntityIds(this.entityIds)
      let liveCount = 0
      for (let index = 0; index < remoteCount && liveCount < MAX_ENTITIES; index++) {
        const entityId = this.entityIds[index]
        const sample = this.entitySample
        // As above, false leaves the buffer stale. Never inspect it on failure.
        if (!session.sampleRemoteEntity(entityId, nowMs, sample)) continue

        const wire = sample.entity
        const view = out.entities[liveCount]
        liveCount++
        view.entityId = wire.entityId
        view.kind = wire.kind
        view.ownerId = wire.ownerId
        view.source = 'interpolated'
        view.position.x = sample.position.x
        view.position.y = sample.position.y
        view.position.z = sample.position.z
        view.heading = wrapAngle(sample.heading)
        view.velocity.x = wire.velocity.x
        view.velocity.y = wire.velocity.y
        view.velocity.z = wire.velocity.z
        view.ttl = wire.ttl
      }
      out.entityCount = liveCount
      for (let index = liveCount; index < MAX_ENTITIES; index++) {
        out.entities[index].entityId = -1
        out.entities[index].source = 'absent'
      }
    } else {
      const entityCount = state.entityCount
      for (let index = 0; index < MAX_ENTITIES; index++) {
        const view = out.entities[index]
        if (index >= entityCount) {
          view.entityId = -1
          view.source = 'absent'
          continue
        }

        const entity = state.entities[index]
        const previousEntity = previous.entities[index]
        view.entityId = entity.entityId
        view.kind = entity.kind
        view.ownerId = entity.ownerId
        view.source = 'authoritative'
        const sameEntity = previousEntity.entityId === entity.entityId
        view.position.x = sameEntity
          ? previousEntity.position.x + (entity.position.x - previousEntity.position.x) * alpha
          : entity.position.x
        view.position.y = sameEntity
          ? previousEntity.position.y + (entity.position.y - previousEntity.position.y) * alpha
          : entity.position.y
        view.position.z = sameEntity
          ? previousEntity.position.z + (entity.position.z - previousEntity.position.z) * alpha
          : entity.position.z
        view.heading = sameEntity
          ? lerpAngle(previousEntity.heading, entity.heading, alpha)
          : entity.heading
        view.velocity.x = entity.velocity.x
        view.velocity.y = entity.velocity.y
        view.velocity.z = entity.velocity.z
        view.ttl = entity.ttl
      }
      out.entityCount = entityCount
    }

    for (let index = 0; index < out.itemBoxes.length; index++) {
      const view = out.itemBoxes[index]
      view.boxIdx = index
      itemBoxWorldPos(ctx, index, view.position)
      view.respawnTicks = state.itemBoxes[index].respawnTicks
    }
    out.itemBoxRespawnTicks = ctx.tuning.itemBoxRespawnTicks

    out.tick = state.tick
    out.alpha = alpha
    out.phase = state.phase
    out.localPlayerId = localId
    out.raceStartTick = session.raceStartTick
    out.finishTick = state.finishTick
    for (let index = 0; index < MAX_KARTS; index++) {
      out.finishedOrder[index] = state.finishedOrder[index]
    }
    out.countdownTicksLeft =
      state.phase === 'countdown' ? Math.max(0, COUNTDOWN_TICKS - state.tick) : 0

    if (import.meta.env.DEV) {
      const violations = viewSourceViolations(out, role)
      if (violations.length > 0) {
        throw new Error(`buildRaceView: seat-source violations:\n${violations.join('\n')}`)
      }
    }
  }
}

/** Allocate all scratch once and prime both session-owned views for audio deltas. */
export function createViewBuilder(session: RaceSession): ViewBuilder {
  const builder = new ViewBuilderImpl(session)
  builder.build(0, session.currentView())
  session.swapViews()
  builder.build(0, session.currentView())
  return builder
}
