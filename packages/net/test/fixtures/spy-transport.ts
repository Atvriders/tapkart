// Wraps a real Transport so a test can observe every message that flows through it without
// contending with whatever the code under test (AuthorityLoop, ClientLoop, ShadowLoop) separately
// registers via its own onMessage call. `onEach` fires for every message before the wrapped user
// callback does; `onMessage` on the returned Transport is what the code under test registers
// against, so exactly one real listener is ever attached to `inner`, regardless of how many times
// this wrapper's own onMessage is (re)called.
//
// `ChannelName` comes from @tapkart/protocol, not from ../../src/transport: transport.ts imports
// that type but never re-exports it, so naming it there is TS2305 ("has no exported member").
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from '../../src/transport'

export function spyTransport(
  inner: Transport,
  onEach: (peerId: string, channel: ChannelName, data: Uint8Array) => void,
): Transport {
  let userCb: ((peerId: string, channel: ChannelName, data: Uint8Array) => void) | null = null
  inner.onMessage((peerId, channel, data) => {
    onEach(peerId, channel, data)
    userCb?.(peerId, channel, data)
  })
  return {
    send: (c, p, d) => inner.send(c, p, d),
    broadcast: (c, d) => inner.broadcast(c, d),
    onMessage: (cb) => {
      userCb = cb
    },
    onPeerLost: (cb) => inner.onPeerLost(cb),
    peers: () => inner.peers(),
    close: () => inner.close(),
  }
}
