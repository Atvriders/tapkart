// PURE — the race-session handoff used when the server shadow promotes. The
// room owns transport lifetime; every underlying session receives a lease.
import type { StartMessage } from '@tapkart/protocol'
import type {
  Intent,
  SimContext,
  SimState,
  Vec3,
} from '@tapkart/sim'
import { cloneState, wrapAngle } from '@tapkart/sim'
import type { RemoteEntitySample, RemoteSample } from '@tapkart/net'
import { makeRemoteSample } from '@tapkart/net'
import type { RaceView, ViewRole } from '@tapkart/render'
import { createRaceView } from '@tapkart/render'
import type { MultiplayerRoom } from './multiplayer'
import { withMirroredLocalInput } from './multiplayer'
import type { RaceSession } from './session'
import { createSession } from './session'

export interface MultiplayerSessionOptions {
  room: MultiplayerRoom
  role: 'host' | 'guest'
  ctx: SimContext
  localPlayerId: number
  start: StartMessage
}

class MultiplayerSession implements RaceSession {
  readonly localPlayerId: number
  readonly ctx: SimContext
  readonly characterIdx: readonly number[]
  readonly raceStartTick: number

  private active: RaceSession
  private authority: RaceSession | null
  private candidate: RaceSession | null = null
  private closed = false

  private viewA: RaceView
  private viewB: RaceView
  private readonly handoffIntent: Intent = {
    tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false,
  }
  private readonly hardResyncCbs: Array<(tick: number) => void> = []
  private readonly authorityProbe: RemoteSample = makeRemoteSample()
  private hardResyncCount = 0
  private adoptionCorrection = false
  private readonly adoptionPosition: Vec3 = { x: 0, y: 0, z: 0 }
  private adoptionHeading = 0

  constructor(opts: MultiplayerSessionOptions) {
    this.localPlayerId = opts.localPlayerId
    this.ctx = { ...opts.ctx }
    this.characterIdx = opts.start.characterIdx.slice()
    this.viewA = createRaceView(opts.ctx.track.itemBoxes.length)
    this.viewB = createRaceView(opts.ctx.track.itemBoxes.length)

    this.active = this.makeUnderlying(opts, opts.role)
    this.authority = opts.role === 'host' ? this.active : null
    this.raceStartTick = this.active.raceStartTick
    this.observeHardResync(this.active, false)

    opts.room.onAuthorityChange(() => {
      if (this.closed || this.authority === null || this.candidate !== null) return
      const candidate = this.makeUnderlying(opts, 'guest')
      this.candidate = candidate
      this.observeHardResync(candidate, true)
    })
  }

  get role(): ViewRole {
    return this.active.role
  }

  private makeUnderlying(
    opts: MultiplayerSessionOptions,
    role: 'host' | 'guest',
  ): RaceSession {
    const ctx: SimContext = { ...opts.ctx, isLeader: role === 'host' }
    const lease = opts.room.borrowRaceTransport()
    return createSession({
      role,
      ctx,
      localPlayerId: opts.localPlayerId,
      seed: opts.start.raceSeed,
      characterIdx: opts.start.characterIdx.slice(),
      humanMask: opts.start.humanMask,
      transport: role === 'host' ? withMirroredLocalInput(lease) : lease,
    })
  }

  private observeHardResync(session: RaceSession, adoptsAuthority: boolean): void {
    session.onHardResync((tick) => {
      this.hardResyncCount++
      if (adoptsAuthority && session === this.candidate && this.authority !== null) {
        this.adoptCandidate(session)
      }
      for (const cb of [...this.hardResyncCbs]) cb(tick)
    })
  }

  private adoptCandidate(candidate: RaceSession): void {
    const old = this.authority
    if (old === null) return
    const before = old.state().karts[this.localPlayerId]
    const after = candidate.state().karts[this.localPlayerId]
    // correctionDelta uses net's post-minus-pre convention. ViewBuilder inverts
    // it, retaining the old rendered pose while the authoritative one eases in.
    this.adoptionPosition.x = after.position.x - before.position.x
    this.adoptionPosition.y = after.position.y - before.position.y
    this.adoptionPosition.z = after.position.z - before.position.z
    this.adoptionHeading = wrapAngle(after.heading - before.heading)
    this.adoptionCorrection = true

    // The candidate's pre-tick state came from race start. It is not a valid
    // interpolation endpoint after a promotion-time rebase.
    cloneState(candidate.state(), candidate.prevState())
    this.active = candidate
    this.ctx.isLeader = false
    this.authority = null
    this.candidate = null
    old.close()
  }

  tickOnce(localIntent: Intent): void {
    if (this.closed) return
    const before = this.active
    const candidate = this.candidate
    before.tickOnce(localIntent)
    if (candidate === null || candidate === before) return

    // Keep the demoted view moving for the few milliseconds until the first
    // server snapshot rebases the hidden client. The candidate owns the real
    // post-promotion input path; the old host's local mirror is duplicate-safe
    // because the shadow ignores input ticks it already holds.
    this.handoffIntent.steer = localIntent.steer
    this.handoffIntent.accel = localIntent.accel
    this.handoffIntent.brake = localIntent.brake
    this.handoffIntent.drift = localIntent.drift
    this.handoffIntent.useItem = localIntent.useItem
    candidate.tickOnce(this.handoffIntent)

    // A late promotion normally hard-resyncs because this freshly-created
    // follower has no ring entry for the server's tick; observeHardResync then
    // adopts it synchronously. An authority change during the first few race
    // ticks is different: the candidate can already have a matching ring entry,
    // and a perfectly matching snapshot applies with neither a correction nor a
    // hard resync. Remote samples are populated only by an accepted snapshot,
    // so this probe closes that edge without trusting raw transport bytes.
    if (
      this.candidate === candidate
      && this.authority !== null
      && candidate.sampleRemoteKart(
        (this.localPlayerId + 1) % candidate.characterIdx.length,
        0,
        this.authorityProbe,
      )
    ) {
      this.adoptCandidate(candidate)
    }
  }

  state(): SimState { return this.active.state() }
  prevState(): SimState { return this.active.prevState() }
  sampleRemoteKart(playerId: number, nowMs: number, out: RemoteSample): boolean {
    return this.active.sampleRemoteKart(playerId, nowMs, out)
  }
  sampleRemoteEntity(entityId: number, nowMs: number, out: RemoteEntitySample): boolean {
    return this.active.sampleRemoteEntity(entityId, nowMs, out)
  }
  remoteEntityIds(out: Int32Array): number { return this.active.remoteEntityIds(out) }
  corrections(): number { return this.active.corrections() }
  correctionDelta(outPos: Vec3): number | null {
    if (this.adoptionCorrection) {
      this.adoptionCorrection = false
      outPos.x = this.adoptionPosition.x
      outPos.y = this.adoptionPosition.y
      outPos.z = this.adoptionPosition.z
      return this.adoptionHeading
    }
    return this.active.correctionDelta(outPos)
  }
  onHardResync(cb: (tick: number) => void): void { this.hardResyncCbs.push(cb) }
  hardResyncs(): number { return this.hardResyncCount }
  currentView(): RaceView { return this.viewA }
  prevView(): RaceView { return this.viewB }
  swapViews(): void {
    const current = this.viewA
    this.viewA = this.viewB
    this.viewB = current
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    const sessions = new Set<RaceSession>([this.active])
    if (this.authority !== null) sessions.add(this.authority)
    if (this.candidate !== null) sessions.add(this.candidate)
    for (const session of sessions) session.close()
    this.authority = null
    this.candidate = null
  }
}

export function createMultiplayerSession(opts: MultiplayerSessionOptions): RaceSession {
  return new MultiplayerSession(opts)
}
