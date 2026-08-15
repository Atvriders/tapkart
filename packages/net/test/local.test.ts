import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent, ItemKind, SimState } from '@tapkart/sim'
import { MAX_KARTS, createState, makeIntentBuffer, statesEqual, step as simStep } from '@tapkart/sim'
import type { InputDatagram } from '@tapkart/protocol'
import { INPUT_REDUNDANCY, decodeHeader, decodeInput, encodeInput } from '@tapkart/protocol'
import { AuthorityLoop } from '../src/authority'
import { ClientLoop } from '../src/client'
import { LOCAL_PEER_ID, createNullTransport, withLocalInput } from '../src/local'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'

const CHARS = [0, 0, 0, 0, 0, 0, 0, 0]
const SEAT = 0
const HEADER_BYTES = 2

function hostState(seed: number): SimState {
  const state = createState(makeNetContext(true), seed, CHARS)
  state.phase = 'racing'
  state.karts[SEAT].isBot = false
  state.karts[SEAT].connected = true
  return state
}

function mkIntent(tick: number, steer: number, accel: number): Intent {
  return { tick, steer, accel, brake: false, drift: false, useItem: false }
}

/**
 * A kart's held item, read through a call rather than off the property.
 *
 * `k.item = 'bolt'` narrows the property to the literal type `'bolt'` for the
 * rest of the enclosing scope, and every later `=== 'none'` then fails to compile
 * under `strict` as a comparison with no overlap - on the exact reads the item
 * test below exists to make. A call's return type cannot be narrowed by an
 * earlier assignment, so this widens it back to `ItemKind` without a cast.
 */
function heldItem(k: { item: ItemKind }): ItemKind {
  return k.item
}

/** The intent as the codec renders it: encodeInput quantises steer to 8 bits
 * over [-1, 1] and accel to 6 bits over [0, 1], and both widths are private to
 * @tapkart/protocol, so this round-trips through the real codec rather than
 * re-deriving them. */
function throughWire(intent: Intent): Intent {
  const window: Intent[] = Array.from({ length: INPUT_REDUNDANCY }, () => ({ ...intent }))
  const buf = new Uint8Array(256)
  const n = encodeInput(buf, 7, window)
  const out: InputDatagram = {
    playerId: -1,
    intents: Array.from({ length: INPUT_REDUNDANCY }, () => mkIntent(0, 0, 0)),
  }
  decodeInput(buf.subarray(0, n), out)
  return out.intents[INPUT_REDUNDANCY - 1]
}

describe('createNullTransport', () => {
  it('is a true zero-peer transport, not one side of an unpumped pair', () => {
    const t = createNullTransport()
    let delivered = 0
    t.onMessage(() => {
      delivered++
    })
    t.onPeerLost(() => {
      delivered++
    })
    expect(t.peers()).toEqual([])
    // 3,600 of these is what a three-minute race broadcasts. None may be
    // retained, and none may come back.
    for (let i = 0; i < 100; i++) {
      t.broadcast('unreliable', new Uint8Array(745))
      t.send('reliable', 'nobody', new Uint8Array(10))
    }
    expect(delivered).toBe(0)
    expect(() => t.close()).not.toThrow()
    expect(t.peers()).toEqual([])
  })
})

describe('withLocalInput', () => {
  it('delivers a real input datagram, from LOCAL_PEER_ID, on the unreliable channel', () => {
    const t = withLocalInput(createNullTransport())
    const seen: { peerId: string; channel: string; dg: InputDatagram }[] = []
    t.onMessage((peerId, channel, data) => {
      // Decoded exactly as a loop decodes it: shared header first, then the body.
      expect(decodeHeader(data).kind).toBe('input')
      const dg: InputDatagram = {
        playerId: -1,
        intents: Array.from({ length: INPUT_REDUNDANCY }, () => mkIntent(0, 0, 0)),
      }
      decodeInput(data.subarray(HEADER_BYTES), dg)
      seen.push({ peerId, channel, dg })
    })

    // Submitting first at a HIGH tick is the case that breaks a window
    // initialised to zeros: encodeInput writes each entry's distance behind the
    // newest tick in 8 bits, and 300 does not fit.
    t.submitLocalInput(3, mkIntent(300, 0.5, 1))
    t.submitLocalInput(3, mkIntent(302, 0.5, 1))

    expect(seen.length).toBe(2)
    expect(seen[0].peerId).toBe(LOCAL_PEER_ID)
    expect(seen[0].channel).toBe('unreliable')
    expect(seen[0].dg.playerId).toBe(3)
    expect(seen[0].dg.intents.length).toBe(INPUT_REDUNDANCY)
    for (const it of seen[0].dg.intents) expect(it.tick).toBe(300)
    // Newest last, and the window really slid rather than being eight copies.
    expect(seen[1].dg.intents[INPUT_REDUNDANCY - 1].tick).toBe(302)
    expect(seen[1].dg.intents[INPUT_REDUNDANCY - 2].tick).toBe(300)
    // Each datagram is its own bytes: the second must not have rewritten the
    // first, which a transport with latency would otherwise deliver as a copy of
    // the newest.
    expect(seen[0].dg.intents[INPUT_REDUNDANCY - 1].tick).toBe(300)
  })

  it('passes every other Transport method straight through to the wrapped transport', () => {
    const sent: string[] = []
    const inner = {
      send: (channel: string) => {
        sent.push(`send:${channel}`)
      },
      broadcast: (channel: string) => {
        sent.push(`broadcast:${channel}`)
      },
      onMessage: () => {},
      onPeerLost: () => {},
      peers: () => ['peerA', 'peerB'],
      close: () => {
        sent.push('close')
      },
    }
    const t = withLocalInput(inner)
    t.send('reliable', 'peerA', new Uint8Array(1))
    t.broadcast('unreliable', new Uint8Array(1))
    // The local player is not a peer: peers() is the network's answer, unchanged.
    expect(t.peers()).toEqual(['peerA', 'peerB'])
    t.close()
    expect(sent).toEqual(['send:reliable', 'broadcast:unreliable', 'close'])
  })
})

describe('AuthorityLoop — a host driving its own kart', () => {
  it('drives the host kart for 120 ticks through the same quantised intent a guest gets', () => {
    const ctx = makeNetContext(true)
    const state = hostState(0)
    const transport = withLocalInput(createNullTransport())
    const authority = new AuthorityLoop(ctx, state, transport)

    // 0.15 is deliberately NOT on the 8-bit steer grid: the nearest code
    // dequantises to 0.14902. accel 1 is exactly representable, so steer is the
    // only field this measures.
    const RAW_STEER = 0.15
    const wire = throughWire(mkIntent(0, RAW_STEER, 1))
    expect(wire.steer).not.toBe(RAW_STEER) // the premise of the whole test

    // Two reference sims, stepped directly through @tapkart/sim with the same
    // seed, same characters, same leader context: one fed the WIRE intent, one
    // fed the RAW one.
    const refCtx = makeNetContext(true)
    let quantA = hostState(0)
    let quantB = hostState(0)
    const rawCtx = makeNetContext(true)
    let rawA = hostState(0)
    let rawB = hostState(0)
    const quantInputs = makeIntentBuffer()
    const rawInputs = makeIntentBuffer()

    const startX = state.karts[SEAT].position.x
    for (let t = 1; t <= 120; t++) {
      transport.submitLocalInput(SEAT, mkIntent(t, RAW_STEER, 1))
      authority.tick()

      for (let i = 0; i < MAX_KARTS; i++) {
        quantInputs[i].tick = quantA.tick + 1
        rawInputs[i].tick = rawA.tick + 1
      }
      // The 30Hz wire cadence, modelled explicitly rather than assumed away:
      // submitLocalInput puts a datagram on the wire on EVEN ticks only (spec
      // §5), so at tick 1 the authority is still holding nothing and steps that
      // tick on a neutral intent, exactly as it does for a guest whose first
      // datagram has not arrived. From tick 2 on it holds the wire intent and
      // applies it to both ticks of every pair.
      const live = t >= 2
      quantInputs[SEAT].steer = live ? wire.steer : 0
      quantInputs[SEAT].accel = live ? wire.accel : 0
      rawInputs[SEAT].steer = live ? RAW_STEER : 0
      rawInputs[SEAT].accel = live ? 1 : 0
      const qEvents: AuthEvent[] = []
      simStep(refCtx, quantA, quantB, quantInputs, qEvents)
      let tmp = quantA
      quantA = quantB
      quantB = tmp
      const rEvents: AuthEvent[] = []
      simStep(rawCtx, rawA, rawB, rawInputs, rEvents)
      tmp = rawA
      rawA = rawB
      rawB = tmp
    }

    // The host actually drove. The control below is what makes that a
    // measurement: an AuthorityLoop over a bare transport, ticked exactly as
    // many times, has NO input source at all - seat 0 is `connected`, so
    // resolveInputs will not bot-fill it either, and the kart simply sits on the
    // grid for the whole race. That is the state of the world this decorator
    // exists to fix.
    const mute = new AuthorityLoop(makeNetContext(true), hostState(0), createNullTransport())
    for (let t = 0; t < 120; t++) mute.tick()
    // Not exactly zero: the seven bot karts alongside it are racing, and
    // resolveKartCollisions shoulders it a few centimetres off the grid over two
    // seconds. It never drives - 0.31 m of being shoved, against the 5+ m of
    // travel the assertion below requires.
    expect(Math.abs(mute.state().karts[SEAT].position.x - startX)).toBeLessThan(1)

    expect(state.tick).toBe(120)
    expect(Math.abs(state.karts[SEAT].position.x - startX)).toBeGreaterThan(5)

    // And it drove the car a GUEST would drive: bit-identical to the reference
    // stepped with the dequantised intent, every field of every kart.
    expect(
      statesEqual(state, quantA),
      'the host kart did not follow the wire-form intent',
    ).toBe(true)
    // ...and NOT the one stepped with the raw analog value, which is what makes
    // the assertion above a measurement rather than a tautology.
    expect(statesEqual(state, rawA)).toBe(false)
    const drift = Math.hypot(
      state.karts[SEAT].position.x - rawA.karts[SEAT].position.x,
      state.karts[SEAT].position.z - rawA.karts[SEAT].position.z,
    )
    expect(drift).toBeGreaterThan(0.001)
  })

  it('keeps driving across a stale resubmission, exactly as it does for a guest', () => {
    // The held-intent path is stateful across ticks; a loop correct on the first
    // datagram and wrong from the second is a bug shape this project has shipped.
    const ctx = makeNetContext(true)
    const state = hostState(0)
    const transport = withLocalInput(createNullTransport())
    const authority = new AuthorityLoop(ctx, state, transport)

    for (let t = 1; t <= 60; t++) {
      transport.submitLocalInput(SEAT, mkIntent(t, 0, 1))
      authority.tick()
    }
    const fast = Math.hypot(state.karts[SEAT].velocity.x, state.karts[SEAT].velocity.z)
    expect(fast).toBeGreaterThan(5)

    for (let t = 61; t <= 120; t++) {
      transport.submitLocalInput(SEAT, mkIntent(t, 0, 0))
      authority.tick()
    }
    const coasting = Math.hypot(state.karts[SEAT].velocity.x, state.karts[SEAT].velocity.z)
    expect(coasting).toBeLessThan(fast)

    // A stale resubmission (older ticks, full throttle) must be ignored, the
    // same way AuthorityLoop ignores a reordered datagram from a guest.
    transport.submitLocalInput(SEAT, mkIntent(10, 0, 1))
    for (let i = 0; i < 60; i++) authority.tick()
    expect(Math.hypot(state.karts[SEAT].velocity.x, state.karts[SEAT].velocity.z)).toBeLessThan(coasting)
  })
})

describe('withLocalInput — the 30Hz wire cadence (Task 15c, review finding 3)', () => {
  /** Every input datagram this transport delivered, decoded. */
  function capture(t: ReturnType<typeof withLocalInput>): InputDatagram[] {
    const seen: InputDatagram[] = []
    t.onMessage((_peerId, _channel, data) => {
      const dg: InputDatagram = {
        playerId: -1,
        intents: Array.from({ length: INPUT_REDUNDANCY }, () => mkIntent(0, 0, 0)),
      }
      decodeInput(data.subarray(HEADER_BYTES), dg)
      seen.push(dg)
    })
    return seen
  }

  it('puts one datagram on the wire every OTHER tick, not one per tick', () => {
    // Spec §5 fixes client input at 30Hz. This decorator imposed no cadence, so
    // a host submitting every tick - the obvious thing to do, and what the
    // shipped example did - fed itself 60Hz input against every guest's 30Hz.
    // The whole reason this decorator exists is that the host must not drive a
    // measurably different car; quantisation parity was achieved and measured,
    // and temporal parity was not.
    const t = withLocalInput(createNullTransport())
    const seen = capture(t)
    for (let tick = 1; tick <= 60; tick++) t.submitLocalInput(SEAT, mkIntent(tick, 0.2, 1))
    expect(seen.length).toBe(30)
    // Even ticks, spaced by exactly 2 - which is also the spacing inside the
    // redundant window, so a receiver's 8-intent window covers 16 ticks of
    // history exactly as a guest's does.
    const newestTicks = seen.map((dg) => dg.intents[INPUT_REDUNDANCY - 1].tick)
    expect(newestTicks.every((n) => n % 2 === 0)).toBe(true)
    expect(newestTicks[0]).toBe(2)
    expect(newestTicks[newestTicks.length - 1]).toBe(60)
    const last = seen[seen.length - 1].intents
    expect(last[INPUT_REDUNDANCY - 1].tick - last[INPUT_REDUNDANCY - 2].tick).toBe(2)
  })

  it('sends exactly as often as a real ClientLoop over the same span', () => {
    // Temporal parity stated as a comparison against the thing it must match,
    // rather than against a number this file chose. If ClientLoop's cadence ever
    // changes, this fails instead of quietly re-opening the gap.
    const host = withLocalInput(createNullTransport())
    const hostSeen = capture(host)

    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 2 })
    let guestSent = 0
    pair.b.onMessage((_p, _c, data) => {
      if (decodeHeader(data).kind === 'input') guestSent++
    })
    const guest = new ClientLoop(makeNetContext(false), SEAT, pair.a)

    let nowMs = 0
    for (let tick = 1; tick <= 120; tick++) {
      host.submitLocalInput(SEAT, mkIntent(tick, 0.2, 1))
      guest.tick(mkIntent(tick, 0.2, 1))
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }
    expect(guestSent, 'the guest sent nothing; the comparison below would be vacuous').toBeGreaterThan(0)
    expect(hostSeen.length).toBe(guestSent)
  })
})

describe('withLocalInput — a host must not lose item presses either (Task 15c item D)', () => {
  /**
   * One race in which the host raises a single-tick `useItem` on exactly one
   * tick. Returns the tick its own AuthorityLoop spent the item on, or -1.
   *
   * `regrantAt` hands the kart a SECOND item with no further press, which is how
   * "the latch cleared after sending" is observable.
   */
  function hostPulseRace(pulseTick: number, regrantAt = -1): { firedAt: number; secondFiredAt: number } {
    const ctx = makeNetContext(true)
    const state = hostState(0x1d)
    // The only items in this race are the ones granted here, so "the item is
    // gone" can only mean it was used.
    for (const box of state.itemBoxes) box.respawnTicks = 1_000_000
    state.karts[SEAT].item = 'bolt'
    const transport = withLocalInput(createNullTransport())
    const authority = new AuthorityLoop(ctx, state, transport)

    let firedAt = -1
    let secondFiredAt = -1
    for (let tick = 1; tick <= 60; tick++) {
      transport.submitLocalInput(SEAT, {
        tick, steer: 0, accel: 1, brake: false, drift: false, useItem: tick === pulseTick,
      })
      authority.tick()
      if (firedAt < 0 && heldItem(state.karts[SEAT]) === 'none') firedAt = tick
      if (tick === regrantAt) state.karts[SEAT].item = 'bolt'
      if (regrantAt > 0 && tick > regrantAt && secondFiredAt < 0 && heldItem(state.karts[SEAT]) === 'none') {
        secondFiredAt = tick
      }
    }
    return { firedAt, secondFiredAt }
  }

  it('puts a useItem pulse submitted on an ODD tick on the wire, instead of dropping it', () => {
    // This decorator drops odd ticks by the same parity rule ClientLoop's send
    // path uses, so it lost item presses in exactly the same way - and Plan 3
    // ruled `useItem` a one-tick pulse emitted on press, so half of a HOST's item
    // uses went nowhere. The fix belongs here and in ClientLoop rather than in
    // Plan 3's adapters: the wire cadence is this package's business, and an
    // adapter that had to know about it would be a second place to get it wrong.
    const odd = hostPulseRace(9)
    expect(odd.firedAt, 'the pulse submitted on an odd tick never reached the authority').toBeGreaterThan(0)

    // Control: the same pulse on an EVEN tick. It always worked - a test that
    // only checked this one passes without the fix.
    const even = hostPulseRace(10)
    expect(even.firedAt).toBeGreaterThan(0)
    expect(Math.abs(odd.firedAt - even.firedAt)).toBeLessThanOrEqual(3)
  })

  it('clears the latch once it has sent, so one press fires one item and not every item after it', () => {
    const r = hostPulseRace(9, 30)
    expect(r.firedAt).toBeGreaterThan(0)
    expect(r.firedAt).toBeLessThan(30)
    expect(
      r.secondFiredAt,
      `the second item was fired on tick ${r.secondFiredAt} with no second press`,
    ).toBe(-1)
  })
})
