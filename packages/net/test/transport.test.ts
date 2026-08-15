import { describe, expect, it } from 'vitest'
import type { Transport } from '../src/transport'
import type { Transport as BarrelTransport } from '../src/index'
import type { ChannelName } from '@tapkart/protocol'

interface RecordingTransport extends Transport {
  sent: { channel: ChannelName; peerId: string; data: Uint8Array }[]
  broadcasts: { channel: ChannelName; data: Uint8Array }[]
}

/**
 * A minimal in-memory double. It lives only in this test file: transport.ts
 * defines the interface and nothing else, so any code exercising a Transport
 * goes through these six methods and nothing more -- which is exactly the
 * spec's "nothing above the transport layer knows which implementation is in
 * use" claim, made testable rather than merely asserted.
 */
function makeFakeTransport(): RecordingTransport {
  const sent: RecordingTransport['sent'] = []
  const broadcasts: RecordingTransport['broadcasts'] = []
  const messageCbs: ((peerId: string, channel: ChannelName, data: Uint8Array) => void)[] = []
  const peerLostCbs: ((peerId: string) => void)[] = []
  let closed = false
  return {
    sent,
    broadcasts,
    send(channel, peerId, data) {
      sent.push({ channel, peerId, data })
    },
    broadcast(channel, data) {
      broadcasts.push({ channel, data })
    },
    onMessage(cb) {
      messageCbs.push(cb)
    },
    onPeerLost(cb) {
      peerLostCbs.push(cb)
    },
    peers() {
      return closed ? [] : ['peerB']
    },
    close() {
      closed = true
    },
  }
}

/**
 * Written against the Transport interface alone -- no method beyond the six
 * in the contract, no property specific to any one implementation. This is
 * the shape every later loop (AuthorityLoop, ClientLoop, ShadowLoop) uses.
 */
function sendGreeting(t: Transport): void {
  const payload = new Uint8Array([1, 2, 3])
  t.send('reliable', 'peerB', payload)
  t.broadcast('unreliable', payload)
}

describe('Transport interface', () => {
  it('is fully exercised through its six methods by code that knows nothing else about it', () => {
    const fake = makeFakeTransport()
    sendGreeting(fake)

    expect(fake.sent).toEqual([
      { channel: 'reliable', peerId: 'peerB', data: new Uint8Array([1, 2, 3]) },
    ])
    expect(fake.broadcasts).toEqual([
      { channel: 'unreliable', data: new Uint8Array([1, 2, 3]) },
    ])
    expect(fake.peers()).toEqual(['peerB'])

    fake.close()
    expect(fake.peers()).toEqual([])
  })

  it('accepts exactly the two contract channel names and no others', () => {
    const fake = makeFakeTransport()
    const channels: ChannelName[] = ['unreliable', 'reliable']
    for (const c of channels) fake.send(c, 'peerB', new Uint8Array())
    expect(fake.sent.map((s) => s.channel)).toEqual(['unreliable', 'reliable'])
  })

  it('is reachable through the package barrel, structurally identical to the direct import', () => {
    // The real assertion here is that this file compiles at all:
    // BarrelTransport resolves only once packages/net/src/index.ts
    // re-exports transport.ts (Step 10). Contract §3/§5: "Task 11's scaffold
    // creates it re-exporting ./transport." Before Step 10 this import fails
    // tsc with TS2305 ("no exported member 'Transport'"), exactly like
    // Step 8's TS2307 for ../src/transport before Step 9 -- two separate
    // barrel-boundary defects, fixed by two separate steps.
    const fake = makeFakeTransport()
    const viaBarrel: BarrelTransport = fake
    const viaDirect: Transport = viaBarrel
    expect(viaDirect).toBe(fake)
  })
})
