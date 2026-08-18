import { describe, expect, it } from 'vitest'
import type { LoopbackOptions } from '../src/loopback'
import { makeLoopbackPair } from '../src/loopback'

const DEFAULTS: LoopbackOptions = { latencyMs: 150, jitterMs: 50, lossRate: 0.05, seed: 0xc0ffee }

describe('makeLoopbackPair', () => {
  it('drops both queued directions on close and notifies the far peer exactly once', () => {
    const { a, b, pump } = makeLoopbackPair({ ...DEFAULTS, jitterMs: 0, lossRate: 0 })
    const atA: number[] = []
    const atB: number[] = []
    const lostAtB: string[] = []
    a.onMessage((_peerId, _channel, data) => atA.push(data[0]))
    b.onMessage((_peerId, _channel, data) => atB.push(data[0]))
    b.onPeerLost((peerId) => lostAtB.push(peerId))

    a.broadcast('reliable', new Uint8Array([1]))
    b.broadcast('reliable', new Uint8Array([2]))
    a.close()
    a.close()
    b.broadcast('reliable', new Uint8Array([3]))
    pump(1000)

    expect(atA).toEqual([])
    expect(atB).toEqual([])
    expect(lostAtB).toEqual(['a'])
    expect(b.peers()).toEqual([])
  })

  it('delivers a message after latencyMs and not before', () => {
    const { a, b, pump } = makeLoopbackPair({ ...DEFAULTS, jitterMs: 0, lossRate: 0 })
    let delivered = false
    b.onMessage(() => { delivered = true })
    a.send('unreliable', 'b', new Uint8Array([1]))

    pump(149)
    expect(delivered).toBe(false)

    pump(150)
    expect(delivered).toBe(true)
  })

  it('loses close to lossRate of 20000 unreliable sends, within a 0.01 band', () => {
    const { a, b, pump } = makeLoopbackPair(DEFAULTS)
    let deliveredCount = 0
    b.onMessage(() => { deliveredCount++ })

    const N = 20000
    for (let i = 0; i < N; i++) a.send('unreliable', 'b', new Uint8Array([i & 0xff]))
    pump(1000) // 150 + up to 50 jitter: every surviving send has arrived by 1000

    const observedLossRate = (N - deliveredCount) / N
    expect(Math.abs(observedLossRate - 0.05)).toBeLessThan(0.01)
  })

  it('produces the identical delivery pattern for the same seed, run twice', () => {
    function run(): number[] {
      const { a, b, pump } = makeLoopbackPair(DEFAULTS)
      const order: number[] = []
      b.onMessage((_peerId, _channel, data) => { order.push(data[0]) })
      for (let i = 0; i < 8; i++) a.send('unreliable', 'b', new Uint8Array([i]))
      pump(1000)
      return order
    }

    const run1 = run()
    const run2 = run()

    expect(run1).toEqual(run2)
    // Locked in by direct simulation of rngAt(0xC0FFEE, cursor) against this
    // exact 8-send sequence (two draws per send, loss then jitter): sent
    // order is 0..7; index 6 draws the least jitter and arrives first, index
    // 1 draws the most and arrives last.
    expect(run1).toEqual([6, 2, 3, 4, 0, 5, 7, 1])
  })

  it('allows out-of-order delivery on unreliable but never on reliable', () => {
    const { a, b, pump } = makeLoopbackPair(DEFAULTS)
    const unreliableOrder: number[] = []
    const reliableOrder: number[] = []
    b.onMessage((_peerId, channel, data) => {
      if (channel === 'unreliable') unreliableOrder.push(data[0])
      else reliableOrder.push(data[0])
    })

    for (let i = 0; i < 8; i++) a.send('unreliable', 'b', new Uint8Array([i]))
    for (let i = 0; i < 8; i++) a.send('reliable', 'b', new Uint8Array([i]))
    pump(1000)

    expect(unreliableOrder).toEqual([6, 2, 3, 4, 0, 5, 7, 1]) // reordered
    expect(reliableOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7])   // never reordered
  })
})
