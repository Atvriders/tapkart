import type { ChannelName } from '@tapkart/protocol'

/**
 * One interface, three implementations (WebRTC, WebSocket, Loopback). Spec
 * §5: "Nothing above the transport layer knows which implementation is in
 * use." Two channels, named by the exact strings 'unreliable' and 'reliable'
 * -- ChannelName is imported from @tapkart/protocol's barrel, not redefined
 * here and not reached by a relative path (contract §3: "net imports
 * @tapkart/protocol, always").
 */
export interface Transport {
  send(channel: ChannelName, peerId: string, data: Uint8Array): void
  broadcast(channel: ChannelName, data: Uint8Array): void
  onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
  onPeerLost(cb: (peerId: string) => void): void
  peers(): string[]
  close(): void
}
