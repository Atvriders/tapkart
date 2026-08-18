// PURE. A server-side Transport over an injected framed-send callback.
import type { Transport } from '@tapkart/net'
import { WS_HEADER_BYTES, WS_SLOT_SERVER, encodeWsData } from '@tapkart/net'
import type { ChannelName } from '@tapkart/protocol'
import type { PeerRecord, RoomRecord } from './types'

export interface RoomTransportOptions {
  room: RoomRecord
  sendFrame: (peer: PeerRecord, frame: Uint8Array) => void
}

export interface RoomTransport extends Transport {
  deliver(peerId: string, channel: ChannelName, payload: Uint8Array): void
  notePeerGone(peerId: string): void
}

export function makeRoomTransport(opts: RoomTransportOptions): RoomTransport {
  const messageCbs: Array<(
    peerId: string,
    channel: ChannelName,
    data: Uint8Array,
  ) => void> = []
  const lostCbs: Array<(peerId: string) => void> = []
  const gone = new Set<string>()
  let closed = false

  function frameOf(channel: ChannelName, data: Uint8Array): Uint8Array {
    const frame = new Uint8Array(WS_HEADER_BYTES + data.length)
    encodeWsData(frame, channel, WS_SLOT_SERVER, data)
    return frame
  }

  function livePeers(): PeerRecord[] {
    const peers: PeerRecord[] = []
    for (const peer of opts.room.peers.values()) {
      if (peer.connected && !gone.has(peer.peerId)) peers.push(peer)
    }
    return peers
  }

  return {
    send(channel, peerId, data): void {
      if (closed) return
      const peer = opts.room.peers.get(peerId)
      if (peer === undefined || !peer.connected || gone.has(peerId)) return
      opts.sendFrame(peer, frameOf(channel, data))
    },

    broadcast(channel, data): void {
      if (closed) return
      for (const peer of livePeers()) opts.sendFrame(peer, frameOf(channel, data))
    },

    onMessage(cb): void {
      messageCbs.push(cb)
    },

    onPeerLost(cb): void {
      lostCbs.push(cb)
    },

    peers(): string[] {
      if (closed) return []
      return livePeers().map((peer) => peer.peerId)
    },

    close(): void {
      if (closed) return
      closed = true
      messageCbs.length = 0
      lostCbs.length = 0
    },

    deliver(peerId, channel, payload): void {
      if (closed) return
      for (const cb of [...messageCbs]) cb(peerId, channel, payload)
    },

    notePeerGone(peerId): void {
      if (closed || gone.has(peerId)) return
      gone.add(peerId)
      for (const cb of [...lostCbs]) cb(peerId)
    },
  }
}
