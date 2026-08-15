// PURE — the composition root for one race. No DOM, wall clock or renderer
// implementation details. This is the game package's sole net-loop constructor.
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
  /** Must equal `(role !== 'guest')`. */
  ctx: SimContext
  /** A seat in [0, MAX_KARTS). */
  localPlayerId: number
  seed: number
  /** Exactly MAX_KARTS entries. Copied, never retained. */
  characterIdx: number[]
  /** Host and solo require the LocalInputTransport extension. */
  transport: Transport
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
  sampleRemoteKart(playerId: number, nowMs: number, out: RemoteSample): boolean
  sampleRemoteEntity(entityId: number, nowMs: number, out: RemoteEntitySample): boolean
  remoteEntityIds(out: Int32Array): number
  corrections(): number
  correctionDelta(outPos: Vec3): number | null
  currentView(): RaceView
  prevView(): RaceView
  swapViews(): void
  close(): void
}

function hasLocalInput(t: Transport): t is LocalInputTransport {
  return typeof (t as Partial<LocalInputTransport>).submitLocalInput === 'function'
}

class Session implements RaceSession {
  readonly role: ViewRole
  readonly localPlayerId: number
  readonly ctx: SimContext
  readonly characterIdx: readonly number[]
  readonly raceStartTick = COUNTDOWN_TICKS

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
      this.live = client.state()
    } else {
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

    const itemBoxCount = opts.ctx.track.itemBoxes.length
    this.viewA = createRaceView(itemBoxCount)
    this.viewB = createRaceView(itemBoxCount)
  }

  tickOnce(localIntent: Intent): void {
    cloneState(this.live, this.prev)

    // Both input paths consume the intent's tick. Stamp it from the live state
    // at the composition boundary instead of trusting every caller to do so.
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

    // Called every sim tick and before the authority advances. The decorator,
    // not this session, owns the 30 Hz cadence and boolean-input latch.
    local.submitLocalInput(this.localPlayerId, localIntent)
    authority.tick()
  }

  state(): SimState {
    return this.live
  }

  prevState(): SimState {
    return this.prev
  }

  sampleRemoteKart(playerId: number, nowMs: number, out: RemoteSample): boolean {
    const interp = this.interp
    if (interp === null || playerId === this.localPlayerId) return false
    return interp.sampleKart(playerId, nowMs, out)
  }

  sampleRemoteEntity(entityId: number, nowMs: number, out: RemoteEntitySample): boolean {
    const interp = this.interp
    if (interp === null) return false
    return interp.sampleEntity(entityId, nowMs, out)
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
      return null
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
    const current = this.viewA
    this.viewA = this.viewB
    this.viewB = current
  }

  close(): void {
    this.transport.close()
  }
}

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

  const wantsLeader = opts.role !== 'guest'
  if (opts.ctx.isLeader !== wantsLeader) {
    throw new Error(
      `createSession: ctx.isLeader must be ${wantsLeader} for role '${opts.role}', got ${opts.ctx.isLeader}`,
    )
  }
  if (wantsLeader && !hasLocalInput(opts.transport)) {
    throw new Error(
      `createSession: role '${opts.role}' requires a LocalInputTransport — wrap the transport with withLocalInput() from @tapkart/net, or use createSoloTransport()`,
    )
  }

  return new Session(opts)
}
