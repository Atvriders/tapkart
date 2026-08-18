import { describe, expect, it } from 'vitest'
import type { ChannelName } from '@tapkart/protocol'
import { encodeCheckpoint, encodeHeader, encodeSnapshot } from '@tapkart/protocol'
import type { Intent, SimState } from '@tapkart/sim'
import { MAX_KARTS, allocStateLike, cloneState, createState, statesEqual } from '@tapkart/sim'
import { ClientLoop } from '../src/client'
import { droppedDatagramsOf } from '../src/receive'
import { AUTHORITY_CHANGE_BYTES, encodeAuthorityChange } from '../src/shadow'
import type { Transport } from '../src/transport'
import { makeNetContext } from './fixtures/net-fixtures'

const SEAT = 1
const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]
const SEED = 0x51ede5

interface FakeTransport extends Transport {
  deliver(channel: ChannelName, data: Uint8Array): void
  sentUnreliable(): number
}

function makeFakeTransport(): FakeTransport {
  const cbs: ((peerId: string, channel: ChannelName, data: Uint8Array) => void)[] = []
  let unreliable = 0
  return {
    send() {
      /* unused: ClientLoop broadcasts */
    },
    broadcast(channel) {
      if (channel === 'unreliable') unreliable++
    },
    onMessage(cb) {
      cbs.push(cb)
    },
    onPeerLost() {
      /* unused */
    },
    peers: () => ['authority'],
    close() {
      /* unused */
    },
    deliver(channel, data) {
      for (const cb of cbs) cb('authority', channel, data)
    },
    sentUnreliable: () => unreliable,
  }
}

function neutralIntent(tick: number): Intent {
  return { tick, steer: 0, accel: 1, brake: false, drift: false, useItem: false }
}

/** An authority-side state, distinguishable from anything the client would
 * predict on its own. */
function authorityState(tick: number): SimState {
  const state = createState(makeNetContext(true), SEED, CHARS)
  state.phase = 'racing'
  state.tick = tick
  state.nextEventSeq = 9
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = state.karts[i]
    k.isBot = i !== SEAT
    k.connected = i === SEAT
    k.position.x = 100 + i
    k.position.z = 200 + i
    k.heading = 0.25 * i
    k.lap.lap = 2
  }
  return state
}

function checkpointDatagram(state: SimState): Uint8Array {
  const buf = new Uint8Array(8192)
  const h = encodeHeader(buf, 'checkpoint')
  const n = encodeCheckpoint(buf.subarray(h), state)
  return buf.slice(0, h + n)
}

function snapshotDatagram(state: SimState): Uint8Array {
  const buf = new Uint8Array(1024)
  const h = encodeHeader(buf, 'snapshot')
  const n = encodeSnapshot(buf.subarray(h), state, new Array<number>(MAX_KARTS).fill(state.tick))
  return buf.slice(0, h + n)
}

function authorityChangeDatagram(tick: number, eventSeq: number): Uint8Array {
  const buf = new Uint8Array(AUTHORITY_CHANGE_BYTES)
  encodeAuthorityChange(buf, tick, eventSeq)
  return buf
}

function makeClient(): { t: FakeTransport; client: ClientLoop } {
  const t = makeFakeTransport()
  return { t, client: new ClientLoop(makeNetContext(false), SEAT, t) }
}

describe('ClientLoop.beginRace', () => {
  it('produces a state statesEqual to createState with the same arguments plus the mask', () => {
    const { client } = makeClient()
    const humanMask = 0b0000_0110 // seats 1 and 2

    client.beginRace(SEED, CHARS, humanMask)

    const expected = createState(makeNetContext(false), SEED, CHARS)
    for (let i = 0; i < MAX_KARTS; i++) {
      const human = ((humanMask >>> i) & 1) === 1
      expected.karts[i].isBot = !human
      expected.karts[i].connected = human
    }
    expect(statesEqual(client.state(), expected)).toBe(true)
  })

  it('leaves the phase at countdown, so the 180-tick freeze runs locally', () => {
    const { client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    expect(client.state().phase).toBe('countdown')
    expect(client.state().tick).toBe(0)
    expect(client.state().raceSeed).toBe(SEED)
  })

  it('applies the mask to every other seat, bit for bit', () => {
    const { client } = makeClient()
    client.beginRace(SEED, CHARS, 0b1000_0001) // seats 0 and 7

    expect(client.state().karts[0].isBot).toBe(false)
    expect(client.state().karts[0].connected).toBe(true)
    expect(client.state().karts[7].isBot).toBe(false)
    expect(client.state().karts[2].isBot).toBe(true)
    expect(client.state().karts[2].connected).toBe(false)
  })

  it('never leaves this loop’s own seat bot-driven, even if the mask omits it', () => {
    // resolveInputs routes a !connected kart through bot AI, so a client whose
    // own bit were clear would predict a kart that ignores every input it
    // produces - and reconciliation would never converge for that seat.
    const { client } = makeClient()
    client.beginRace(SEED, CHARS, 0b0000_0001) // seat 0 only; not this loop's
    expect(client.state().karts[SEAT].isBot).toBe(false)
    expect(client.state().karts[SEAT].connected).toBe(true)
  })

  it('clears the ring, the correction count and the hard-resync count', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    for (let i = 0; i < 30; i++) client.tick(neutralIntent(i + 1))

    // A snapshot for a tick the ring cannot reach forces a hard resync.
    t.deliver('unreliable', snapshotDatagram(authorityState(5000)))
    client.tick(neutralIntent(31))
    expect(client.hardResyncs()).toBe(1)
    expect(client.corrections()).toBeGreaterThan(0)

    client.beginRace(SEED, CHARS, 0b11)

    expect(client.hardResyncs()).toBe(0)
    expect(client.corrections()).toBe(0)
    expect(client.state().tick).toBe(0)

    // The ring is empty, so the next snapshot cannot anchor either: proof the
    // window was cleared rather than left holding a dead timeline.
    let resyncs = 0
    client.onHardResync(() => resyncs++)
    t.deliver('unreliable', snapshotDatagram(authorityState(4000)))
    client.tick(neutralIntent(1))
    expect(resyncs).toBe(1)
  })
})

describe('ClientLoop.onHardResync', () => {
  it('fires with the tick the loop rebased onto, for every listener', () => {
    const { t, client } = makeClient()
    const a: number[] = []
    const b: number[] = []
    client.onHardResync((tick) => a.push(tick))
    client.onHardResync((tick) => b.push(tick))

    client.beginRace(SEED, CHARS, 0b11)
    t.deliver('unreliable', snapshotDatagram(authorityState(4321)))
    client.tick(neutralIntent(1))

    expect(a).toEqual([4321])
    expect(b).toEqual([4321])
    expect(client.hardResyncs()).toBe(1)
    expect(client.state().tick).toBe(4321)
  })

  it('does not fire when reconciliation finds its anchor', () => {
    const { t, client } = makeClient()
    let fired = 0
    client.onHardResync(() => fired++)
    client.beginRace(SEED, CHARS, 0b11)
    for (let i = 0; i < 10; i++) client.tick(neutralIntent(i + 1))

    t.deliver('unreliable', snapshotDatagram(authorityState(8)))
    client.tick(neutralIntent(11))

    expect(fired).toBe(0)
    expect(client.hardResyncs()).toBe(0)
  })
})

describe('ClientLoop - checkpoint on the reliable channel', () => {
  it('adopts the decoded state whole, and clears the ring', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    for (let i = 0; i < 20; i++) client.tick(neutralIntent(i + 1))

    const truth = authorityState(900)
    t.deliver('reliable', checkpointDatagram(truth))

    expect(client.state().tick).toBe(900)
    expect(statesEqual(client.state(), truth)).toBe(true)

    // Everything buffered against the old timeline was worthless, and the ring
    // proves it: the very next snapshot has nothing to anchor against.
    let resyncs = 0
    client.onHardResync(() => resyncs++)
    t.deliver('unreliable', snapshotDatagram(authorityState(950)))
    client.tick(neutralIntent(901))
    expect(resyncs).toBe(1)
    expect(client.state().tick).toBe(950)
  })

  it('drops a truncated checkpoint, counts it, and changes NOTHING', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    for (let i = 0; i < 5; i++) client.tick(neutralIntent(i + 1))
    const before = allocStateLike(makeNetContext(false), client.state())
    cloneState(client.state(), before)
    const droppedBefore = droppedDatagramsOf(client)

    const full = checkpointDatagram(authorityState(900))
    t.deliver('reliable', full.subarray(0, full.length - 40))

    expect(droppedDatagramsOf(client)).toBe(droppedBefore + 1)
    expect(statesEqual(client.state(), before)).toBe(true)
  })

  it('ignores a checkpoint on the unreliable channel', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    const tick = client.state().tick

    t.deliver('unreliable', checkpointDatagram(authorityState(900)))

    expect(client.state().tick).toBe(tick)
  })
})

describe('ClientLoop - authorityChange on the reliable channel', () => {
  it('raises nextEventSeq and changes no kart field', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    for (let i = 0; i < 12; i++) client.tick(neutralIntent(i + 1))
    const before = allocStateLike(makeNetContext(false), client.state())
    cloneState(client.state(), before)

    t.deliver('reliable', authorityChangeDatagram(742, 31))

    // Spec §5: "there is no rewind" - the shadow has been ticking all along.
    expect(client.state().tick).toBe(before.tick)
    expect(client.state().phase).toBe(before.phase)
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(client.state().karts[i].position.x).toBe(before.karts[i].position.x)
      expect(client.state().karts[i].position.z).toBe(before.karts[i].position.z)
      expect(client.state().karts[i].heading).toBe(before.karts[i].heading)
      expect(client.state().karts[i].lap.lap).toBe(before.karts[i].lap.lap)
      expect(client.state().karts[i].isBot).toBe(before.karts[i].isBot)
      expect(client.state().karts[i].connected).toBe(before.karts[i].connected)
    }
    // The one field that moves: without it, the promoted authority's first
    // event is rejected as a duplicate by applyEvent's
    // `ev.eventSeq < state.nextEventSeq` guard, silently, on every client.
    expect(client.state().nextEventSeq).toBe(31)
  })

  it('never LOWERS nextEventSeq', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    t.deliver('reliable', authorityChangeDatagram(700, 40))
    t.deliver('reliable', authorityChangeDatagram(800, 12))
    expect(client.state().nextEventSeq).toBe(40)
  })

  it('drops a truncated authorityChange and counts it', () => {
    const { t, client } = makeClient()
    const droppedBefore = droppedDatagramsOf(client)
    t.deliver('reliable', authorityChangeDatagram(700, 40).subarray(0, 6))
    expect(droppedDatagramsOf(client)).toBe(droppedBefore + 1)
    expect(client.state().nextEventSeq).toBe(0)
  })

  it('ignores an authorityChange on the unreliable channel', () => {
    const { t, client } = makeClient()
    t.deliver('unreliable', authorityChangeDatagram(700, 40))
    expect(client.state().nextEventSeq).toBe(0)
  })
})

describe('ClientLoop - the four members that must not have moved', () => {
  it('still predicts, still sends input at 30 Hz, and still reports corrections', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    for (let i = 0; i < 10; i++) client.tick(neutralIntent(i + 1))

    expect(client.state().tick).toBe(10)
    expect(t.sentUnreliable()).toBe(5) // every other tick
    expect(client.corrections()).toBe(0)
  })
})
