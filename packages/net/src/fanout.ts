import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from './transport'

/**
 * PURE (contract §0a). Spec §5: "Every client sends its input to BOTH the host
 * and the server shadow." Plan 2 §5 resolved that as "a client's transport holds
 * two peers", but no type in the repository combined two transports into one.
 * This is it - and it never learns which of its parts is WebRTC and which is a
 * WebSocket, because nothing above the transport layer knows either.
 */
export const PEER_ID_SEPARATOR = '/'

export interface FanOutPart {
  id: string
  transport: Transport
}

export interface FanOutTransport extends Transport {
  /** Late-joining guests appear on the host mid-lobby, so parts are dynamic. */
  addPart(part: FanOutPart): void
  removePart(id: string): void
  partIds(): string[]
}

/**
 * Peer ids are namespaced `partId + '/' + peerId` so two parts cannot collide.
 * AuthorityLoop uses peerId only as a Map key, so any opaque string works - but
 * a room log with `rtc/host` in it is easier to read than a UUID, and readable
 * room logs are worth the assertion in addPart.
 */
export function scopePeerId(partId: string, peerId: string): string {
  return partId + PEER_ID_SEPARATOR + peerId
}

export function splitPeerId(scoped: string): { partId: string; peerId: string } | null {
  const at = scoped.indexOf(PEER_ID_SEPARATOR)
  // Split at the FIRST separator: a part id may not contain one (asserted on
  // add), so this is exact even if an inner peer id somehow does.
  if (at <= 0 || at === scoped.length - 1) return null
  return { partId: scoped.slice(0, at), peerId: scoped.slice(at + 1) }
}

export function makeFanOutTransport(parts?: FanOutPart[]): FanOutTransport {
  const order: string[] = []
  const byId = new Map<string, Transport>()
  const messageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const peerLostCbs: Array<(peerId: string) => void> = []
  let closed = false

  function emitPeerLost(scoped: string): void {
    for (const cb of [...peerLostCbs]) cb(scoped)
  }

  const self: FanOutTransport = {
    addPart(part): void {
      if (closed) throw new Error('addPart: fan-out is closed')
      // These three throws are on THIS PROCESS'S OWN wiring data, at
      // composition time - the opposite of an untrusted-input path, and the
      // same class as lobbyPathFor's throw. A silently accepted ambiguous id
      // would misroute inputs for a whole race.
      if (part.id.length === 0 || part.id.includes(PEER_ID_SEPARATOR)) {
        throw new Error(`addPart: part id '${part.id}' must be non-empty and contain no '${PEER_ID_SEPARATOR}'`)
      }
      if (byId.has(part.id)) throw new Error(`addPart: duplicate part id '${part.id}'`)
      for (const peerId of part.transport.peers()) {
        if (peerId.includes(PEER_ID_SEPARATOR)) {
          throw new Error(`addPart: peer id '${peerId}' in part '${part.id}' contains '${PEER_ID_SEPARATOR}'`)
        }
      }
      order.push(part.id)
      byId.set(part.id, part.transport)
      // One listener per part, registered once at add. Transport.onMessage
      // appends, so this never disturbs a listener the part already had.
      part.transport.onMessage((peerId, channel, data) => {
        // Transport has no unsubscribe. Identity against the current map entry
        // makes callbacks from a removed (or same-id replaced) part inert.
        if (closed || byId.get(part.id) !== part.transport) return
        const scoped = scopePeerId(part.id, peerId)
        for (const cb of [...messageCbs]) cb(scoped, channel, data)
      })
      part.transport.onPeerLost((peerId) => {
        if (closed || byId.get(part.id) !== part.transport) return
        emitPeerLost(scopePeerId(part.id, peerId))
      })
    },
    removePart(id): void {
      if (closed) return
      const t = byId.get(id)
      if (t === undefined) return
      // Peer loss FIRST, then the part: an authority that never hears about
      // these peers keeps their karts frozen on the track instead of handing
      // them to a bot.
      for (const peerId of t.peers()) emitPeerLost(scopePeerId(id, peerId))
      byId.delete(id)
      const at = order.indexOf(id)
      if (at >= 0) order.splice(at, 1)
      // NOT closed: the caller owns that transport's lifetime, and a promoted
      // authority reuses the same socket.
    },
    partIds(): string[] {
      return [...order]
    },
    send(channel, peerId, data): void {
      if (closed) return
      const split = splitPeerId(peerId)
      // An unparseable or unknown scoped id is a no-op, not a throw
      // (Transport rule 4).
      if (split === null) return
      const t = byId.get(split.partId)
      if (t === undefined) return
      t.send(channel, split.peerId, data)
    },
    broadcast(channel, data): void {
      if (closed) return
      // ONE call, N recipients, across every part - exactly the shape
      // ClientLoop.tick already uses.
      for (const id of order) byId.get(id)?.broadcast(channel, data)
    },
    onMessage(cb): void {
      messageCbs.push(cb)
    },
    onPeerLost(cb): void {
      peerLostCbs.push(cb)
    },
    peers(): string[] {
      if (closed) return []
      const out: string[] = []
      for (const id of order) {
        const t = byId.get(id)
        if (t === undefined) continue
        for (const peerId of t.peers()) out.push(scopePeerId(id, peerId))
      }
      return out
    },
    close(): void {
      if (closed) return
      closed = true
      for (const id of order) byId.get(id)?.close()
    },
  }

  if (parts !== undefined) {
    for (const p of parts) self.addPart(p)
  }
  return self
}
