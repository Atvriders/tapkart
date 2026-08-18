// PURE. The caller supplies the scheduler clock and the room transport.
import {
  ShadowLoop,
  advanceAccumulator,
  makeTickAccumulator,
  promotionTickOf,
  withPeerAuthority,
} from '@tapkart/net'
import { MAX_KARTS, createState } from '@tapkart/sim'
import type { SimContext } from '@tapkart/sim'
import { seatMapOf } from './lobby'
import type { LogSink } from './log'
import type { RoomTransport } from './roomtransport'
import type { RaceRuntime, RoomRecord } from './types'

export interface StartRaceOptions {
  room: RoomRecord
  ctx: SimContext
  seed: number
  characterIdx: number[]
  humanMask: number
  transport: RoomTransport
  nowMs: number
}

export function startRace(opts: StartRaceOptions): RaceRuntime {
  if (opts.ctx.isLeader) {
    throw new Error(
      'startRace: ctx.isLeader must be false; contextFor allocates a fresh SimContext per race',
    )
  }
  if (opts.room.race !== null) {
    throw new Error('startRace: this room already has a race; a shadow is never introduced mid-race')
  }

  const state = createState(opts.ctx, opts.seed >>> 0, opts.characterIdx)
  for (let i = 0; i < MAX_KARTS; i++) {
    const human = ((opts.humanMask >>> i) & 1) === 1
    state.karts[i].isBot = !human
    state.karts[i].connected = human
  }

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

export function stepRace(run: RaceRuntime, nowMs: number): number {
  const ticks = advanceAccumulator(run.acc, nowMs - run.lastPollMs)
  run.lastPollMs = nowMs
  for (let i = 0; i < ticks; i++) run.shadow.tick(nowMs)
  return ticks
}

const logged = new WeakSet<RaceRuntime>()

export function pollRace(run: RaceRuntime, log: LogSink, nowMs: number): boolean {
  const tick = promotionTickOf(run.shadow)
  if (tick < 0 || logged.has(run)) return false
  logged.add(run)
  log.write({ kind: 'promotion', code: '', tick, eventSeq: run.state.nextEventSeq }, nowMs)
  return true
}

export function endRace(run: RaceRuntime): void {
  run.room.close()
}
