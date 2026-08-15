import { describe, expect, it } from 'vitest'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'

describe('makeNetContext', () => {
  it('builds a SimContext over the Plan 1 oval track with the fixture tuning and characters', () => {
    const ctx = makeNetContext()
    expect(ctx.track.id).toBe('oval')
    expect(ctx.characters.length).toBe(8)
    expect(ctx.tuning.kartRadius).toBe(0.9)
    expect(ctx.isLeader).toBe(true)

    // Proves query is built from the real oval track, not a stub: this is
    // makeOvalTrack()'s own first control point, confirmed by running
    // buildTrackQuery(makeOvalTrack()).sampleAt(0) directly.
    const p0 = ctx.query.sampleAt(0)
    expect(p0.position.x).toBe(-200)
    expect(p0.position.z).toBe(-100)
    expect(p0.width).toBe(24)
  })

  it('honours an explicit isLeader', () => {
    expect(makeNetContext(false).isLeader).toBe(false)
    expect(makeNetContext(true).isLeader).toBe(true)
  })
})

describe('makeLossyPair', () => {
  it('defaults to spec §8\'s conditions: 150ms latency, 50ms jitter, 5% loss, seed 0xC0FFEE', () => {
    const { a, b, pump } = makeLossyPair()
    let delivered = false
    b.onMessage(() => { delivered = true })
    a.send('unreliable', 'b', new Uint8Array([9]))

    pump(149)
    expect(delivered).toBe(false)
    pump(250) // 150 + up to 50 jitter: always arrived by 250
    expect(delivered).toBe(true)
  })

  it('applies overrides on top of the defaults', () => {
    const { a, b, pump } = makeLossyPair({ lossRate: 1 })
    let delivered = false
    b.onMessage(() => { delivered = true })
    a.send('unreliable', 'b', new Uint8Array([9]))
    pump(1000)
    expect(delivered).toBe(false) // lossRate 1 drops every unreliable send
  })
})
