import { describe, expect, it } from 'vitest'
import type { SimContext } from '@tapkart/sim'
import { MAX_KARTS, createState } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import type { ShadowLoop, Transport } from '@tapkart/net'
import {
  AuthorityLoop,
  HOST_TIMEOUT_MS,
  MAX_CATCHUP_TICKS,
  TICK_MS,
  advanceAccumulator,
  createLiveness,
  makeLoopbackPair,
  makeTickAccumulator,
  peerAuthorityDropsOf,
  promotionTickOf,
} from '@tapkart/net'
import type { PeerId, PeerRecord, RaceRuntime, RoomRecord } from '../src/types'
import type { RoomTransport } from '../src/roomtransport'
import { endRace, pollRace, startRace, stepRace } from '../src/race'
import { makeMemoryLogSink } from '../src/log'
import { makeContext, makeOvalTrack } from '../../sim/test/fixtures/track-fixtures'

function makeServerContext(): SimContext {
  return makeContext(makeOvalTrack(), false)
}

function makeRoom(hostPeerId: string | null): RoomRecord {
  const room: RoomRecord = {
    code: 'ABCDE',
    createdAtMs: 0,
    lastActivityMs: 0,
    phase: 'racing',
    hostPeerId,
    hostPlayerId: 0,
    trackId: 'oval',
    lobbyVersion: 1,
    raceSeed: 0,
    peers: new Map<PeerId, PeerRecord>(),
    slotsInUse: new Set<number>(),
    seats: new Array<PeerId | null>(MAX_KARTS).fill(null),
    rtcFailures: 0,
    race: null,
  }
  if (hostPeerId !== null) {
    const host: PeerRecord = {
      peerId: hostPeerId,
      slot: 1,
      playerId: 0,
      token: '',
      role: 'host',
      name: 'host',
      characterIdx: 0,
      ready: true,
      relay: false,
      connected: true,
      joinedAtMs: 0,
      lastSeenMs: 0,
      liveness: createLiveness(0),
    }
    room.peers.set(hostPeerId, host)
    room.seats[0] = hostPeerId
  }
  return room
}

function nullTransport(): RoomTransport {
  return {
    send: () => {},
    broadcast: () => {},
    onMessage: () => {},
    onPeerLost: () => {},
    peers: () => [],
    close: () => {},
    deliver: () => {},
    notePeerGone: () => {},
  }
}

function asRoomTransport(inner: Transport): RoomTransport {
  return {
    send: (channel: ChannelName, peerId: string, data: Uint8Array) => {
      inner.send(channel, peerId, data)
    },
    broadcast: (channel: ChannelName, data: Uint8Array) => {
      inner.broadcast(channel, data)
    },
    onMessage: (cb) => { inner.onMessage(cb) },
    onPeerLost: (cb) => { inner.onPeerLost(cb) },
    peers: () => inner.peers(),
    close: () => { inner.close() },
    deliver: () => { throw new Error('this harness delivers through the loopback pair') },
    notePeerGone: () => { throw new Error('this harness has no hub') },
  }
}

function startedRace(
  transport: RoomTransport,
  nowMs = 0,
): { run: RaceRuntime; room: RoomRecord } {
  const room = makeRoom('host')
  const run = startRace({
    room,
    ctx: makeServerContext(),
    seed: 1234,
    characterIdx: new Array<number>(MAX_KARTS).fill(0),
    humanMask: 0b1,
    transport,
    nowMs,
  })
  room.race = run
  return { run, room }
}

describe('startRace', () => {
  it('builds the shadow state and applies humanMask to isBot/connected', () => {
    const { run } = startedRace(nullTransport())
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
    expect(promotionTickOf(run.shadow)).toBe(-1)
  })

  it('refuses a context that is already a leader', () => {
    const ctx = makeServerContext()
    ctx.isLeader = true
    expect(() => startRace({
      room: makeRoom('host'),
      ctx,
      seed: 1,
      characterIdx: new Array<number>(MAX_KARTS).fill(0),
      humanMask: 1,
      transport: nullTransport(),
      nowMs: 0,
    })).toThrow(/isLeader/)
  })

  it('refuses to put a second shadow on a live race', () => {
    const { run, room } = startedRace(nullTransport())
    expect(room.race).toBe(run)
    expect(() => startRace({
      room,
      ctx: makeServerContext(),
      seed: 2,
      characterIdx: new Array<number>(MAX_KARTS).fill(0),
      humanMask: 1,
      transport: nullTransport(),
      nowMs: 100,
    })).toThrow(/already/)
  })

  it('routes the shadow through withPeerAuthority', () => {
    const { run } = startedRace(nullTransport())
    expect(peerAuthorityDropsOf(run.transport)).toEqual({
      wrongSeat: 0,
      notAuthority: 0,
      malformed: 0,
    })
  })
})

describe('stepRace', () => {
  function recorder(run: RaceRuntime): number[] {
    const calls: number[] = []
    run.shadow = { tick: (nowMs: number) => { calls.push(nowMs) } } as unknown as ShadowLoop
    return calls
  }

  it('turns one tick interval into exactly one tick', () => {
    const { run } = startedRace(nullTransport())
    const calls = recorder(run)
    expect(stepRace(run, TICK_MS)).toBe(1)
    expect(calls).toEqual([TICK_MS])
    expect(run.lastPollMs).toBe(TICK_MS)
  })

  it('hands advanceAccumulator a delta, not a timestamp', () => {
    const { run } = startedRace(nullTransport())
    recorder(run)
    expect(stepRace(run, TICK_MS)).toBe(1)
    expect(stepRace(run, TICK_MS * 2)).toBe(1)
    expect(run.lastPollMs).toBe(TICK_MS * 2)
  })

  it('clamps a stall and gives every tick the same absolute nowMs', () => {
    const { run } = startedRace(nullTransport())
    const calls = recorder(run)
    expect(stepRace(run, 1000)).toBe(MAX_CATCHUP_TICKS)
    expect(calls).toEqual(new Array<number>(MAX_CATCHUP_TICKS).fill(1000))
    expect(run.acc.residualMs).toBe(0)
    calls.length = 0
    const nextTickAt = 1000 + TICK_MS + 0.001
    expect(stepRace(run, nextTickAt)).toBe(1)
    expect(calls).toEqual([nextTickAt])
  })

  it('advances lastPollMs exactly once per call, even when no tick runs', () => {
    const { run } = startedRace(nullTransport())
    const calls = recorder(run)
    expect(stepRace(run, 8)).toBe(0)
    expect(calls).toEqual([])
    expect(run.lastPollMs).toBe(8)
    expect(stepRace(run, 16)).toBe(0)
    expect(run.lastPollMs).toBe(16)
    expect(stepRace(run, 20)).toBe(1)
  })
})

describe('pollRace', () => {
  it('writes exactly one promotion line, on the first pass that sees it', () => {
    const { run } = startedRace(nullTransport())
    const log = makeMemoryLogSink()
    expect(pollRace(run, log, 100)).toBe(false)
    expect(log.events()).toEqual([])
    run.shadow.promote(42)
    expect(promotionTickOf(run.shadow)).toBe(42)
    expect(pollRace(run, log, 200)).toBe(true)
    expect(pollRace(run, log, 208)).toBe(false)
    expect(pollRace(run, log, 216)).toBe(false)
    const promotions = log.events().filter((event) => event.kind === 'promotion')
    expect(promotions).toHaveLength(1)
    expect(promotions[0]).toEqual({
      kind: 'promotion',
      code: '',
      tick: 42,
      eventSeq: run.state.nextEventSeq,
    })
  })
})

describe('endRace', () => {
  it('closes the room transport it was given', () => {
    let closed = 0
    const transport = nullTransport()
    const run = startRace({
      room: makeRoom('host'),
      ctx: makeServerContext(),
      seed: 5,
      characterIdx: new Array<number>(MAX_KARTS).fill(0),
      humanMask: 1,
      transport: { ...transport, close: () => { closed++ } },
      nowMs: 0,
    })
    endRace(run)
    expect(closed).toBe(1)
  })
})

describe('promotion over a lossy link', () => {
  it('promotes at 1500 ms of silence and not before, without rewinding', () => {
    const link = makeLoopbackPair({
      latencyMs: 150,
      jitterMs: 50,
      lossRate: 0.05,
      seed: 20260814,
    })

    let hostPeerId = ''
    link.b.onMessage((peerId) => { if (hostPeerId === '') hostPeerId = peerId })
    let probeAt = 0
    while (hostPeerId === '' && probeAt < 2000) {
      link.a.broadcast('reliable', new Uint8Array([0xff, 0xff]))
      probeAt += 16
      link.pump(probeAt)
    }
    expect(hostPeerId).not.toBe('')

    const room = makeRoom(hostPeerId)
    const characterIdx = [0, 1, 2, 3, 4, 5, 6, 7]
    const humanMask = 0b1
    const hostCtx = makeServerContext()
    hostCtx.isLeader = true
    const hostState = createState(hostCtx, 987_654, characterIdx)
    for (let i = 0; i < MAX_KARTS; i++) {
      const human = ((humanMask >>> i) & 1) === 1
      hostState.karts[i].isBot = !human
      hostState.karts[i].connected = human
    }
    const host = new AuthorityLoop(hostCtx, hostState, link.a)

    const start = probeAt
    const run = startRace({
      room,
      ctx: makeServerContext(),
      seed: 987_654,
      characterIdx,
      humanMask,
      transport: asRoomTransport(link.b),
      nowMs: start,
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
        link.pump(now)
        if (hostAlive) {
          const ticks = advanceAccumulator(hostAcc, now - hostLast)
          hostLast = now
          for (let i = 0; i < ticks; i++) host.tick()
        }
        stepRace(run, now)
        pollRace(run, log, now)
        for (let i = 0; i < MAX_KARTS; i++) {
          expect(run.state.karts[i].lap.lap).toBeGreaterThanOrEqual(laps[i])
          laps[i] = run.state.karts[i].lap.lap
        }
        expect(run.state.nextEventSeq).toBeGreaterThanOrEqual(lastSeq)
        lastSeq = run.state.nextEventSeq
        maxEntityCount = Math.max(maxEntityCount, run.state.entityCount)
      }
      return now
    }

    let now = advance(start + 8, start + 20_000)
    expect(run.state.tick).toBeGreaterThan(1000)
    expect(host.state().tick).toBeGreaterThan(1000)
    const drops = peerAuthorityDropsOf(run.transport)
    expect(drops.notAuthority).toBe(0)
    expect(drops.wrongSeat).toBe(0)
    expect(run.state.karts[1].position.x).not.toBe(gridX)
    expect(maxEntityCount).toBeGreaterThan(0)
    expect(promotionTickOf(run.shadow)).toBe(-1)

    hostAlive = false
    const silentAt = now
    const entitiesBefore = run.state.entityCount
    const seqBefore = run.state.nextEventSeq
    now = advance(now, silentAt + HOST_TIMEOUT_MS - 300)
    expect(promotionTickOf(run.shadow)).toBe(-1)

    now = advance(now, silentAt + HOST_TIMEOUT_MS + 400)
    const promotionTick = promotionTickOf(run.shadow)
    expect(promotionTick).toBeGreaterThanOrEqual(0)
    expect(log.events().filter((event) => event.kind === 'promotion')).toHaveLength(1)
    expect(run.state.tick).toBeGreaterThan(promotionTick - 5)
    expect(run.state.entityCount).toBeGreaterThanOrEqual(Math.max(0, entitiesBefore - 2))
    expect(run.state.nextEventSeq).toBeGreaterThanOrEqual(seqBefore)
    expect(run.ctx.isLeader).toBe(true)
    expect(run.state.raceSeed).toBe(987_654)

    const tickAtPromotion = run.state.tick
    now = advance(now, now + 1000)
    expect(run.state.tick).toBeGreaterThan(tickAtPromotion + 50)
  })
})
