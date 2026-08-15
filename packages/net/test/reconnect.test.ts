import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent, SimState } from '@tapkart/sim'
import { MAX_KARTS, createState } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import { encodeEvents, encodeHeader, encodeInput, encodeSnapshot } from '@tapkart/protocol'
import type { Transport } from '../src/transport'
import { AuthorityLoop } from '../src/authority'
import { ShadowLoop, decodeAuthorityChange } from '../src/shadow'
import { TICK_MS } from '../src/clock'
import { makeNetContext } from './fixtures/net-fixtures'

const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]
const SEAT = 2
const SNAP_BUF_BYTES = 1024

interface Capture {
  transport: Transport
  broadcasts: { channel: ChannelName; data: Uint8Array }[]
  deliver(peerId: string, channel: ChannelName, data: Uint8Array): void
  losePeer(peerId: string): void
}

/** A Transport whose peer-loss callback a test can actually FIRE.
 * makeLoopbackPair stores onPeerLost callbacks and never invokes them - not even
 * on close() - so no test built on it can reach either loop's drop handling. */
function captureTransport(): Capture {
  const broadcasts: { channel: ChannelName; data: Uint8Array }[] = []
  let cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void = () => {}
  let lost: (peerId: string) => void = () => {}
  return {
    broadcasts,
    deliver: (peerId, channel, data) => cb(peerId, channel, data),
    losePeer: (peerId) => lost(peerId),
    transport: {
      send() {},
      broadcast: (channel, data) => {
        broadcasts.push({ channel, data })
      },
      onMessage: (fn) => {
        cb = fn
      },
      onPeerLost: (fn) => {
        lost = fn
      },
      peers: () => [],
      close() {},
    },
  }
}

function racingState(seed: number): SimState {
  const state = createState(makeNetContext(false), seed, CHARS)
  state.phase = 'racing'
  state.karts[SEAT].isBot = false
  state.karts[SEAT].connected = true
  return state
}

function sendInput(cap: Capture, peerId: string, baseTick: number, intent: Omit<Intent, 'tick'>): void {
  const window: Intent[] = Array.from({ length: 8 }, (_, i) => ({ ...intent, tick: baseTick + i * 2 }))
  const buf = new Uint8Array(256)
  const h = encodeHeader(buf, 'input')
  const n = encodeInput(buf.subarray(h), SEAT, window)
  cap.deliver(peerId, 'unreliable', buf.slice(0, h + n))
}

const FLAT_OUT = { steer: 0, accel: 1, brake: false, drift: false, useItem: false }
const STOPPING = { steer: 0, accel: 0, brake: true, drift: false, useItem: false }

/**
 * Spec §5: "A client that drops has its kart taken over by a bot ... and
 * reclaims it on reconnect with the same room code."
 *
 * The first half shipped (onPeerLost clears `connected`, and resolveInputs
 * bot-fills any kart whose `connected` is false). NOTHING ever set it back, so
 * the second half did not exist at all: a reconnecting player's datagrams were
 * decoded and held, then discarded on every single tick, and their kart stayed
 * bot-driven for the rest of the race with no error anywhere.
 */

/**
 * ShadowLoop.tick takes the scheduler's wall clock as of Task 15c item C, so
 * every call site here drives one through a driver that advances it by exactly
 * one 60Hz tick per call - which is what a healthy scheduler does, and therefore
 * preserves the meaning every test in this file had when tick() took no
 * argument.
 *
 * `stall(ms)` is the case the tick counter could not see: wall time passing with
 * NO tick running.
 */
function driverFor(shadow: ShadowLoop, startMs = 0): {
  tick(n?: number): void
  stall(deltaMs: number): void
  nowMs(): number
} {
  let ms = startMs
  return {
    tick(n = 1): void {
      for (let i = 0; i < n; i++) {
        shadow.tick(ms)
        ms += TICK_MS
      }
    },
    stall(deltaMs: number): void {
      ms += deltaMs
    },
    nowMs(): number {
      return ms
    },
  }
}

describe('AuthorityLoop — a dropped player reclaims their seat by sending input', () => {
  it('bot-fills on drop and hands the seat back on the next input datagram', () => {
    const ctx = makeNetContext(true)
    const state = racingState(0x601)
    const cap = captureTransport()
    const authority = new AuthorityLoop(ctx, state, cap.transport)

    // A control that suffers the same drop and never reconnects, so "the human
    // is driving again" is measured against a kart that is genuinely still
    // bot-driven rather than against a guessed speed.
    const controlCtx = makeNetContext(true)
    const controlState = racingState(0x601)
    const controlCap = captureTransport()
    const control = new AuthorityLoop(controlCtx, controlState, controlCap.transport)

    const both = (n: number): void => {
      for (let i = 0; i < n; i++) {
        authority.tick()
        control.tick()
      }
    }

    sendInput(cap, 'c2', 0, FLAT_OUT)
    sendInput(controlCap, 'c2', 0, FLAT_OUT)
    both(40)
    const drivingSpeed = Math.hypot(state.karts[SEAT].velocity.x, state.karts[SEAT].velocity.z)
    expect(drivingSpeed).toBeGreaterThan(5)

    cap.losePeer('c2')
    controlCap.losePeer('c2')
    expect(state.karts[SEAT].connected).toBe(false)
    both(60) // 60 ticks of bot driving, so the hold is genuinely stale

    // The reconnect: same seat, newer input ticks, and an intent no bot would
    // ever produce - full brake. This is the whole mechanism; no new message
    // kind exists or is needed.
    //
    // The base tick is the AUTHORITY'S OWN, not a round number picked to be
    // "clearly newer". A reconnecting client's ClientLoop kept ticking while its
    // link was down, so the ticks it sends track the authority's; the flat 200
    // this line used to carry described a client whose clock had run 1.7s ahead
    // of the host, which the wire-cursor bound now refuses as an implausible
    // jump (malformed.test.ts pins that refusal). Deriving it also keeps this
    // test honest if the tick counts above ever change.
    sendInput(cap, 'c2', state.tick, STOPPING)
    expect(
      state.karts[SEAT].connected,
      'input for a disconnected seat did not reclaim it; the kart stays bot-driven for the rest of the race',
    ).toBe(true)

    both(90)
    const reclaimedSpeed = Math.hypot(state.karts[SEAT].velocity.x, state.karts[SEAT].velocity.z)
    const botSpeed = Math.hypot(controlState.karts[SEAT].velocity.x, controlState.karts[SEAT].velocity.z)
    expect(reclaimedSpeed).toBeLessThan(1) // braked to a stop, as instructed
    expect(botSpeed).toBeGreaterThan(5) // the control kart is still racing
    expect(controlState.karts[SEAT].connected).toBe(false)
  })
})

describe('ShadowLoop — the same drop and reclaim, because a promoted shadow IS the authority', () => {
  it('bot-fills a dropped peer and hands the seat back on its next input datagram', () => {
    const ctx = makeNetContext(false)
    const state = racingState(0x602)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    sendInput(cap, 'c2', 0, FLAT_OUT)
    drive.tick(40)
    const drivingSpeed = Math.hypot(state.karts[SEAT].velocity.x, state.karts[SEAT].velocity.z)
    expect(drivingSpeed).toBeGreaterThan(5)

    // Before this loop had an onPeerLost at all, the callback below reached
    // nobody: ShadowLoop never registered one, so a client that dropped after
    // promotion kept a kart nobody drove.
    cap.losePeer('c2')
    drive.tick(30)
    expect(
      state.karts[SEAT].connected,
      'ShadowLoop ignored the peer loss; the seat is still marked connected',
    ).toBe(false)
    // Bot-driven now, so it is still racing rather than frozen.
    expect(Math.hypot(state.karts[SEAT].velocity.x, state.karts[SEAT].velocity.z)).toBeGreaterThan(5)

    // Base tick from the loop's own counter, for the reason the AuthorityLoop
    // test above spells out: a reconnecting client's ticks track the
    // authority's, and a flat 200 here described a client 144 ticks ahead of
    // this loop - a cursor jump the receive guard now refuses.
    sendInput(cap, 'c2', state.tick, STOPPING)
    drive.tick(90)
    expect(state.karts[SEAT].connected).toBe(true)
    expect(Math.hypot(state.karts[SEAT].velocity.x, state.karts[SEAT].velocity.z)).toBeLessThan(1)
  })
})

describe('ShadowLoop — eventSeq continues from the highest the host announced', () => {
  it('takes WireSnapshot.eventSeq as a floor when it promotes', () => {
    // Spec §5's "continues eventSeq from the highest it observed". Without this,
    // a host event lost in flight leaves this loop's counter behind the host's,
    // and after promotion it re-issues sequence numbers the host already spent -
    // which every client IGNORES (applyEvent gates on `eventSeq < nextEventSeq`),
    // so the new authority's events are silently dropped by the whole room until
    // its counter climbs past the host's.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x603, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick(10)
    expect(state.nextEventSeq).toBe(0) // nothing applied: this follower has emitted nothing

    // A host snapshot announcing a counter far ahead of this loop's own - the
    // shape produced by a burst of host events that never arrived.
    const host = createState(ctx, 0x603, CHARS)
    host.tick = 10
    host.nextEventSeq = 100
    const buf = new Uint8Array(SNAP_BUF_BYTES)
    const h = encodeHeader(buf, 'snapshot')
    const n = encodeSnapshot(buf.subarray(h), host, new Array(MAX_KARTS).fill(-1))
    cap.deliver('host', 'unreliable', buf.slice(0, h + n))
    drive.tick()
    // Still 0 while FOLLOWING: contract §1b is explicit that a follower's
    // counter advances only by applying received events, and applySnapshotToState
    // deliberately excludes the field. The floor is held beside the state.
    expect(state.nextEventSeq).toBe(0)

    shadow.promote(state.tick)

    expect(state.nextEventSeq, 'the promoted shadow will re-issue sequence numbers the host already spent').toBeGreaterThanOrEqual(100)
    const announcement = cap.broadcasts.find((b) => b.channel === 'reliable')
    expect(announcement).toBeDefined()
    expect(decodeAuthorityChange(announcement!.data).eventSeq).toBeGreaterThanOrEqual(100)
  })

  it('never LOWERS the counter: an old snapshot cannot undo applied events', () => {
    // The floor is a max, not an assignment. A snapshot older than the events
    // this loop has already applied must be a no-op, or promotion would re-issue
    // sequence numbers this loop itself already handed out.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x604, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    const events: AuthEvent[] = [
      { eventSeq: 5, tick: 1, kind: 'respawn', playerId: 0, entityId: -1, item: 'none', data: 30 },
    ]
    const evBuf = new Uint8Array(4096)
    const eh = encodeHeader(evBuf, 'events')
    const en = encodeEvents(evBuf.subarray(eh), events)
    cap.deliver('host', 'reliable', evBuf.slice(0, eh + en))
    drive.tick()
    expect(state.nextEventSeq).toBe(6)

    const host = createState(ctx, 0x604, CHARS)
    host.tick = 1
    host.nextEventSeq = 0
    const buf = new Uint8Array(SNAP_BUF_BYTES)
    const h = encodeHeader(buf, 'snapshot')
    const n = encodeSnapshot(buf.subarray(h), host, new Array(MAX_KARTS).fill(-1))
    cap.deliver('host', 'unreliable', buf.slice(0, h + n))
    drive.tick()

    shadow.promote(state.tick)
    expect(state.nextEventSeq).toBe(6)
    const announcement = cap.broadcasts.find((b) => b.channel === 'reliable')
    expect(decodeAuthorityChange(announcement!.data).eventSeq).toBe(6)
  })
})
