import { describe, expect, it } from 'vitest'
import type { Intent, SimState } from '@tapkart/sim'
import {
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  createState,
  statesEqual,
} from '@tapkart/sim'
import { encodeHeader, encodeSnapshot } from '@tapkart/protocol'
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from '@tapkart/net'
import {
  createNullTransport,
  makeRemoteEntitySample,
  makeRemoteSample,
  withLocalInput,
} from '@tapkart/net'
import { renderNowMs } from '../src/clock'
import { createSoloTransport } from '../src/localinput'
import type { RaceSession } from '../src/session'
import { createSession } from '../src/session'
import { makeGameContext, makeSessionPair } from './fixtures/game-fixtures'

const CHARACTER_IDX = [3, 5, 1, 7, 2, 6, 0, 4]

interface DeliverTransport extends Transport {
  deliver(channel: ChannelName, data: Uint8Array): void
}

function makeDeliverTransport(): DeliverTransport {
  const callbacks: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  return {
    send: () => {},
    broadcast: () => {},
    onMessage: (cb) => { callbacks.push(cb) },
    onPeerLost: () => {},
    peers: () => ['authority'],
    close: () => {},
    deliver(channel, data): void {
      for (const cb of callbacks) cb('authority', channel, data)
    },
  }
}

function snapshotDatagram(state: SimState): Uint8Array {
  const buffer = new Uint8Array(1024)
  const header = encodeHeader(buffer, 'snapshot')
  const body = encodeSnapshot(
    buffer.subarray(header),
    state,
    new Array<number>(MAX_KARTS).fill(state.tick),
  )
  return buffer.slice(0, header + body)
}

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
  const s = makeSolo(0)
  const it = intent(steer, accel)
  for (let t = 0; t < ticks; t++) s.tickOnce(it)
  const p = s.state().karts[0].position
  const out = { x: p.x, z: p.z }
  s.close()
  return out
}

describe('createSession — construction and validation', () => {
  it('starts a guest from the server seed, characters and exact human mask', () => {
    const humanMask = 0b1000_0101
    const session = createSession({
      role: 'guest',
      ctx: makeGameContext(false),
      localPlayerId: 2,
      seed: 0x1234,
      characterIdx: CHARACTER_IDX.slice(),
      humanMask,
      transport: createNullTransport(),
    })
    const expected = createState(makeGameContext(false), 0x1234, CHARACTER_IDX)
    for (let i = 0; i < MAX_KARTS; i++) {
      const human = ((humanMask >>> i) & 1) === 1
      expected.karts[i].isBot = !human
      expected.karts[i].connected = human
    }
    expect(statesEqual(session.state(), expected)).toBe(true)
    session.close()
  })

  it('gives host and guest the same human/bot seat map', () => {
    const humanMask = 0b1010_0101
    const host = createSession({
      role: 'host',
      ctx: makeGameContext(true),
      localPlayerId: 0,
      seed: 9,
      characterIdx: CHARACTER_IDX.slice(),
      humanMask,
      transport: withLocalInput(createNullTransport()),
    })
    const guest = createSession({
      role: 'guest',
      ctx: makeGameContext(false),
      localPlayerId: 2,
      seed: 9,
      characterIdx: CHARACTER_IDX.slice(),
      humanMask,
      transport: createNullTransport(),
    })
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(guest.state().karts[i].isBot).toBe(host.state().karts[i].isBot)
      expect(guest.state().karts[i].connected).toBe(host.state().karts[i].connected)
    }
    host.close()
    guest.close()
  })

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
        ctx: makeGameContext(true),
        localPlayerId: 1,
        seed: 1,
        characterIdx: CHARACTER_IDX.slice(),
        transport: createNullTransport(),
      }),
    ).toThrow(/ctx\.isLeader/)
  })
})

describe("solo drives the AuthorityLoop with the player's own intent (Q15, R42)", () => {
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
    t.close()
  })
})

describe("prevState — Q9's second SimState", () => {
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
  it('delegates hard-resync callbacks and count from ClientLoop', () => {
    const transport = makeDeliverTransport()
    const session = createSession({
      role: 'guest',
      ctx: makeGameContext(false),
      localPlayerId: 1,
      seed: 7,
      characterIdx: CHARACTER_IDX.slice(),
      humanMask: 0b11,
      transport,
    })
    const a: number[] = []
    const b: number[] = []
    session.onHardResync((tick) => a.push(tick))
    session.onHardResync((tick) => b.push(tick))

    const authority = createState(makeGameContext(true), 7, CHARACTER_IDX)
    authority.tick = 4321
    authority.phase = 'racing'
    transport.deliver('unreliable', snapshotDatagram(authority))
    session.tickOnce(intent(0, 1))

    expect(a).toEqual([4321])
    expect(b).toEqual([4321])
    expect(session.hardResyncs()).toBe(1)
    session.close()
  })

  it('samples remote seats from the interpolator and never the local one', () => {
    const pair = makeSessionPair()
    const it = intent(0.2, 1)
    for (let t = 1; t <= 260; t++) {
      pair.host.tickOnce(it)
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(t, 0))
    }
    const now = renderNowMs(pair.guest.state().tick, 0)

    // P2-R29: caller-owned buffers, made ONCE — here, not inside any loop.
    const sample = makeRemoteSample()
    const entitySample = makeRemoteEntitySample()

    expect(pair.guest.sampleRemoteKart(1, now, sample)).toBe(false)
    expect(pair.guest.sampleRemoteKart(0, now, sample)).toBe(true)
    expect(sample.kart.playerId).toBe(0)

    // A refused sample leaves the buffer ALONE — it still holds seat 0.
    expect(pair.guest.sampleRemoteKart(1, now, sample)).toBe(false)
    expect(sample.kart.playerId).toBe(0)

    expect(pair.host.sampleRemoteKart(1, now, sample)).toBe(false)
    expect(pair.host.sampleRemoteEntity(1, now, entitySample)).toBe(false)
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
      it.steer = Math.sin(t / 12)
      const before = pair.guest.corrections()
      pair.host.tickOnce({
        tick: 0,
        steer: 0.1,
        accel: 1,
        brake: false,
        drift: false,
        useItem: false,
      })
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(t, 0))
      const corrected = pair.guest.corrections() > before
      const delta = pair.guest.correctionDelta(out)
      if (delta !== null) seenNonNull++
      if (corrected !== (delta !== null)) mismatches++
    }

    expect(pair.guest.corrections()).toBeGreaterThan(0)
    expect(seenNonNull).toBeGreaterThan(0)
    expect(mismatches).toBe(0)

    pair.host.close()
    pair.guest.close()
  })
})
