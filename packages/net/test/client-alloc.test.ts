import type { Mock } from 'vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent } from '@tapkart/sim'

/**
 * "step() must not allocate in the hot path" is a locked constraint, and
 * AuthorityLoop honours it by preallocating everything it needs. ClientLoop did
 * not: it built a whole SimState (allocStateLike), an eight-slot intent buffer
 * (makeIntentBuffer), an events array and an Intent literal on EVERY tick, and
 * the 128-entry ring then held 128 of those SimStates alive - measured at 157
 * objects / 17.8 KB per tick, ~9,400 objects/s, 2.3 MB retained.
 *
 * "Fewer allocations" is the easiest claim in this repository to assert
 * vacuously, so this file does not measure heap bytes, which are GC-dependent
 * and noisy. It counts CALLS to the two sim allocators ClientLoop used per tick,
 * by mocking @tapkart/sim so both are spies over their real implementations. The
 * count is exact, deterministic, and impossible to satisfy by accident: before
 * the pooling change it is one of each per tick.
 *
 * READ THE TITLE NARROWLY. "No allocation in the hot path" is what this file is
 * ABOUT; what it MEASURES is calls to `allocStateLike` and `makeIntentBuffer`,
 * two functions, and nothing else. Object literals, array pushes and `slice`
 * calls elsewhere in tick() are invisible to it - ClientLoop's receive path
 * deliberately allocates ~2.75 KB per accepted snapshot and this file would not
 * notice if that became 2.75 MB. A per-frame API's allocations are pinned where
 * they can be seen instead: by object identity, in client.test.ts's
 * out-parameter contract block.
 */
vi.mock('@tapkart/sim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tapkart/sim')>()
  return {
    ...actual,
    allocStateLike: vi.fn(actual.allocStateLike),
    makeIntentBuffer: vi.fn(actual.makeIntentBuffer),
  }
})

// Imported AFTER the vi.mock call above in source order, but hoisting makes the
// mock take effect first - and ClientLoop's own import of @tapkart/sim resolves
// to the same mocked module, which is the point.
import * as sim from '@tapkart/sim'
import { encodeHeader, encodeSnapshot } from '@tapkart/protocol'
import { AuthorityLoop } from '../src/authority'
import { ClientLoop } from '../src/client'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'

const OWN = 4
const CHARS8 = [0, 0, 0, 0, 0, 0, 0, 0]

const allocStateLikeSpy = sim.allocStateLike as unknown as Mock
const makeIntentBufferSpy = sim.makeIntentBuffer as unknown as Mock

function mkIntent(steer: number): Intent {
  return { tick: 0, steer, accel: 1, brake: false, drift: false, useItem: false }
}

describe('ClientLoop — no allocation in the hot path', () => {
  beforeEach(() => {
    allocStateLikeSpy.mockClear()
    makeIntentBufferSpy.mockClear()
  })

  it('the instrument itself works: these two counters do move', () => {
    // Without this control every "zero calls" assertion below would also pass
    // against a spy that was never wired to the module under test at all -
    // exactly the class of test this project has shipped sixteen of.
    const ctx = makeNetContext(false)
    const state = sim.createState(ctx, 0, CHARS8)
    expect(allocStateLikeSpy.mock.calls.length).toBe(0)
    sim.allocStateLike(ctx, state)
    sim.makeIntentBuffer()
    expect(allocStateLikeSpy.mock.calls.length).toBe(1)
    expect(makeIntentBufferSpy.mock.calls.length).toBe(1)
  })

  it('allocates its whole ring up front and nothing per tick, over 600 ticks', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 2 })
    const client = new ClientLoop(ctx, OWN, pair.a)

    // Construction is allowed to allocate as much as it likes: this is the
    // fixed-capacity ring being built once, plus the loop's scratch states.
    const allocAtConstruction = allocStateLikeSpy.mock.calls.length
    const intentBuffersAtConstruction = makeIntentBufferSpy.mock.calls.length
    expect(allocAtConstruction).toBeGreaterThan(0)

    let nowMs = 0
    // 600 ticks, which is nearly five times the 128-entry ring capacity: a pool
    // filled lazily on first use would still be allocating for the first 128 of
    // them, and a ring that grew on wrap would allocate for all 600.
    for (let t = 0; t < 600; t++) {
      client.tick(mkIntent(0.2))
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }
    expect(client.state().tick).toBe(600)

    expect(
      allocStateLikeSpy.mock.calls.length - allocAtConstruction,
      'ClientLoop.tick() built a SimState; the ring is fixed-capacity and must be pooled',
    ).toBe(0)
    expect(
      makeIntentBufferSpy.mock.calls.length - intentBuffersAtConstruction,
      'ClientLoop.tick() built an intent buffer; preallocate one and rewrite it in place',
    ).toBe(0)
  })

  it('allocates nothing per tick on the reconciling path either, against a real AuthorityLoop', () => {
    // The correcting path is the one that matters most - it is also the one that
    // runs a replay - so it gets its own measurement rather than being assumed
    // to follow from the quiet one.
    const ctxA = makeNetContext(true)
    const state = sim.createState(ctxA, 0, CHARS8)
    state.phase = 'racing'
    state.karts[OWN].isBot = false
    state.karts[OWN].connected = true

    const pair = makeLossyPair({ latencyMs: 150, jitterMs: 50, lossRate: 0.05, seed: 0xc0ffee })
    const authority = new AuthorityLoop(ctxA, state, pair.a)
    const client = new ClientLoop(makeNetContext(false), OWN, pair.b)

    // Force real corrections rather than hoping for them: a snapshot stream
    // offset from the client's own prediction corrects on most snapshots.
    const mirror = sim.allocStateLike(makeNetContext(true), client.state())
    const buf = new Uint8Array(1024)
    const lastProcessed = new Array(8).fill(-1)

    const allocBefore = allocStateLikeSpy.mock.calls.length
    const buffersBefore = makeIntentBufferSpy.mock.calls.length

    let nowMs = 0
    for (let t = 0; t < 300; t++) {
      authority.tick()
      client.tick(mkIntent(0.3))
      if (client.state().tick % 3 === 0) {
        sim.cloneState(client.state(), mirror)
        mirror.karts[OWN].position.x += 0.5 // ten epsilons: a guaranteed correction
        const h = encodeHeader(buf, 'snapshot')
        const n = encodeSnapshot(buf.subarray(h), mirror, lastProcessed)
        pair.a.broadcast('unreliable', buf.slice(0, h + n))
      }
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    // The window really did reconcile, so "no allocations" is not a statement
    // about a code path that never ran.
    expect(client.corrections()).toBeGreaterThan(10)
    // cloneState above is not counted by either spy; both counters cover only
    // what this loop allocates.
    expect(allocStateLikeSpy.mock.calls.length - allocBefore).toBe(0)
    expect(makeIntentBufferSpy.mock.calls.length - buffersBefore).toBe(0)
  }, 30000)
})
