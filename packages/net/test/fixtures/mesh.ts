// A three-party topology built out of the pair transports this plan actually ships.
//
// WHY THIS EXISTS. Spec §5 has every client sending its input to BOTH the host and the server
// shadow, and has the shadow receiving the host's snapshots and events at the same time.
// `makeLoopbackPair` (Task 12) is a PAIR: a message broadcast on side `a` reaches side `b` and vice
// versa, so three parties cannot share one bus. Task 17's brief worked around that by placing two
// loops on one pair and having the TEST hand-broadcast the client's datagrams on both sides - which
// covers the dual-send behaviour but never runs a real `ClientLoop` next to a real `ShadowLoop`.
//
// This fixture closes that without adding anything to `src`: three independent loopback pairs, one
// per link, and a fan-out Transport per participant. Contract §5's module map still lists exactly
// `transport.ts` and `loopback.ts`, and this file is test-only, exactly as `net-fixtures.ts` and
// `track-fixtures.ts` are.
//
//        client ──HC── host
//           │           │
//           └────CS────┐│
//                     shadow            (HS: host ↔ shadow)
//
// Each link draws its OWN loss and jitter from its OWN seed. That is deliberate: with one shared
// seed, host→client and host→shadow would lose the same datagrams on the same ticks, and a bug that
// only appears when one peer misses what another received could never show up.
import type { ChannelName } from '@tapkart/protocol'
import type { LoopbackOptions } from '../../src/loopback'
import type { Transport } from '../../src/transport'
import { makeLossyPair } from './net-fixtures'

/**
 * One participant's view of one link: the pair side it owns, plus the name every datagram arriving
 * over it is attributed to.
 *
 * The name matters. `makeLoopbackPair` delivers with the SENDING SIDE's letter as the peerId, so
 * every link reports its far end as 'a' or 'b' - two different links both report 'b', and a loop
 * that maps peerId -> playerId (AuthorityLoop and ShadowLoop both do) would treat two different
 * peers as one, mis-seat a reconnect and bot-fill the wrong kart on a peer loss. Relabelling here
 * gives each far end a name unique across the mesh.
 */
export interface MeshLink {
  transport: Transport
  peerId: string
}

/**
 * One Transport that speaks over several links at once.
 *
 * `broadcast` goes out on every link, which is what a broadcast means for a peer with several
 * connections. `send` also goes out on every link: `makeLoopbackPair` ignores the peerId it is
 * handed (its far end is unambiguous), and no loop in this plan sends unicast at all, so there is
 * nothing here to route by. If one ever does, this is the line that has to learn about it.
 */
export function fanOutTransport(links: MeshLink[]): Transport {
  if (links.length === 0) throw new Error('fanOutTransport: needs at least one link')
  return {
    send(channel, peerId, data) {
      for (const l of links) l.transport.send(channel, peerId, data)
    },
    broadcast(channel, data) {
      for (const l of links) l.transport.broadcast(channel, data)
    },
    onMessage(cb) {
      for (const l of links) {
        // The link's own name, not the loopback side letter - see MeshLink.
        l.transport.onMessage((_peerId: string, channel: ChannelName, data: Uint8Array) => {
          cb(l.peerId, channel, data)
        })
      }
    },
    onPeerLost(cb) {
      for (const l of links) l.transport.onPeerLost(() => cb(l.peerId))
    },
    peers() {
      const out: string[] = []
      for (const l of links) {
        // A closed link reports no peers; its name then drops out of this list too.
        if (l.transport.peers().length > 0) out.push(l.peerId)
      }
      return out
    },
    close() {
      for (const l of links) l.transport.close()
    },
  }
}

export interface ThreeWayMesh {
  /** The host's Transport: links to the client and to the shadow. */
  host: Transport
  /** The guest's Transport: links to the host and to the shadow (spec §5's dual send). */
  client: Transport
  /** The server shadow's Transport: links to the host and to the client. */
  shadow: Transport
  /** Advances all three links to `nowMs`, delivering whatever is due. Absolute, not a delta. */
  pump(nowMs: number): void
}

/**
 * One seed per link, exported so a recorded run can store the transport it was recorded over. A
 * caller may override every other LoopbackOption; these stay distinct regardless, for the reason in
 * this file's header.
 */
export const MESH_LINK_SEEDS = {
  hostClient: 0xc0ffee,
  hostShadow: 0x5eed01,
  clientShadow: 0x5eed02,
} as const

/**
 * Three lossy links at spec §8's conditions (150ms latency, 50ms jitter, 5% loss), one per pair of
 * participants. `overrides` applies to all three, except for the per-link seed.
 */
export function makeThreeWayMesh(overrides?: Partial<LoopbackOptions>): ThreeWayMesh {
  const hostClient = makeLossyPair({ ...overrides, seed: MESH_LINK_SEEDS.hostClient })
  const hostShadow = makeLossyPair({ ...overrides, seed: MESH_LINK_SEEDS.hostShadow })
  const clientShadow = makeLossyPair({ ...overrides, seed: MESH_LINK_SEEDS.clientShadow })

  return {
    host: fanOutTransport([
      { transport: hostClient.a, peerId: 'client' },
      { transport: hostShadow.a, peerId: 'shadow' },
    ]),
    client: fanOutTransport([
      { transport: hostClient.b, peerId: 'host' },
      { transport: clientShadow.a, peerId: 'shadow' },
    ]),
    shadow: fanOutTransport([
      { transport: hostShadow.b, peerId: 'host' },
      { transport: clientShadow.b, peerId: 'client' },
    ]),
    pump(nowMs: number): void {
      hostClient.pump(nowMs)
      hostShadow.pump(nowMs)
      clientShadow.pump(nowMs)
    },
  }
}
