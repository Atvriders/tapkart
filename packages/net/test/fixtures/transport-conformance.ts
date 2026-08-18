import type { ChannelName } from '@tapkart/protocol'
import { describe, expect, it } from 'vitest'
import type { Transport } from '../../src/transport'

/**
 * Contract §9.2. One shared suite, run against every Transport
 * implementation. Keeping these assertions together prevents a transport from
 * implementing only the subset its immediate caller happens to exercise.
 */
export interface ConformanceHarness {
  a: Transport
  b: Transport
  /** Deliver everything currently in flight. */
  flush(): void
  /** Simulate the far end vanishing, so onPeerLost must fire. */
  dropB(): void
}

interface Received {
  peerId: string
  channel: ChannelName
  bytes: number[]
}

function record(t: Transport, into: Received[]): void {
  t.onMessage((peerId, channel, data) => {
    into.push({ peerId, channel, bytes: Array.from(data) })
  })
}

export function runTransportConformance(name: string, make: () => ConformanceHarness): void {
  describe(`${name} — Transport conformance (§2.1)`, () => {
    it('1. onMessage registers an additional listener; it never replaces one', () => {
      const h = make()
      const first: Received[] = []
      const second: Received[] = []
      record(h.b, first)
      record(h.b, second)

      h.a.broadcast('reliable', new Uint8Array([0x03, 0x02, 0x77]))
      h.flush()

      expect(first).toHaveLength(1)
      expect(second).toHaveLength(1)
      expect(first[0].bytes).toEqual([0x03, 0x02, 0x77])
      expect(second[0].bytes).toEqual([0x03, 0x02, 0x77])
    })

    it('2. onPeerLost appends too, and fires for a peer that vanished', () => {
      const h = make()
      const first: string[] = []
      const second: string[] = []
      h.a.onPeerLost((peerId) => first.push(peerId))
      h.a.onPeerLost((peerId) => second.push(peerId))

      h.dropB()
      h.flush()

      expect(first).toHaveLength(1)
      expect(second).toEqual(first)
    })

    it('3. broadcast reaches the far end and never the sender', () => {
      const h = make()
      const atA: Received[] = []
      const atB: Received[] = []
      record(h.a, atA)
      record(h.b, atB)

      h.a.broadcast('unreliable', new Uint8Array([0x11, 0x02, 0x01]))
      h.flush()

      expect(atB).toHaveLength(1)
      expect(atB[0].channel).toBe('unreliable')
      expect(atA).toEqual([])
    })

    it('4. send to an unknown peer is a no-op, not a throw', () => {
      const h = make()
      const atB: Received[] = []
      record(h.b, atB)

      expect(() => {
        h.a.send('reliable', 'definitely-not-a-peer', new Uint8Array([1, 2]))
      }).not.toThrow()
      h.flush()
      expect(atB).toEqual([])

      const target = h.a.peers()[0]
      expect(target).toBeDefined()
      h.a.send('reliable', target, new Uint8Array([3, 4]))
      h.flush()
      expect(atB).toHaveLength(1)
    })

    it('5. close is idempotent, empties peers, and stops traffic both ways', () => {
      const h = make()
      const atA: Received[] = []
      const atB: Received[] = []
      record(h.a, atA)
      record(h.b, atB)

      h.a.close()
      h.a.close()

      expect(h.a.peers()).toEqual([])
      h.a.broadcast('reliable', new Uint8Array([9, 9]))
      h.b.broadcast('reliable', new Uint8Array([8, 8]))
      h.flush()
      expect(atA).toEqual([])
      expect(atB).toEqual([])
    })

    it('6. delayed delivery owns the bytes that were sent', () => {
      const h = make()
      const atB: Received[] = []
      record(h.b, atB)

      const buf = new Uint8Array([0x11, 0x02, 0x41])
      h.a.broadcast('unreliable', buf)
      buf[2] = 0x5a
      h.flush()

      expect(atB).toHaveLength(1)
      expect(atB[0].bytes).toEqual([0x11, 0x02, 0x41])
    })
  })
}
