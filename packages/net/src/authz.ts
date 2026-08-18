// PURE (contract §0a). A decorator over a Transport and a seat map: no socket,
// no clock, no RTCPeerConnection, no timer, and every decision in it is a unit
// test in packages/net/test/authz.test.ts.
import type { ChannelName } from '@tapkart/protocol'
import { WIRE_TAG, playerIdOfInput } from '@tapkart/protocol'
import type { Transport } from './transport'

/** encodeHeader writes [tag, protocolVersion] and returns 2. */
const HEADER_BYTES = 2

export interface PeerAuthority {
  /** The seat this peer is authorised to submit input for, or -1 for none. */
  playerIdOf(peerId: string): number
  /** True only for the peer currently entitled to originate AUTHORITATIVE
   *  traffic - snapshots, events, checkpoints, authorityChange. On the server
   *  that is the room's host peer, until the shadow promotes; after promotion
   *  nothing inbound is authoritative and this returns false for everyone. */
  isAuthority(peerId: string): boolean
}

export interface PeerAuthorityDrops {
  /** Input datagrams whose claimed playerId was not this peer's seat. */
  wrongSeat: number
  /** Authoritative kinds from a peer that is not the authority. */
  notAuthority: number
  /** Datagrams too short to classify. */
  malformed: number
}

/**
 * The four kinds only an authority may originate. `authorityChange` is in this
 * set and it is the most important member: AuthorityLoop demotes on ANY foreign
 * authorityChange without reading the body (correctly - no transport loops a
 * broadcast back to its sender, so every one it sees is foreign), which means
 * two bytes with tag 0x20 from any peer permanently stop a host broadcasting.
 * Where a shadow exists that degrades to a server-authoritative race; where one
 * does not, the room has no authority left at all.
 */
const AUTHORITATIVE_TAGS: ReadonlySet<number> = new Set<number>([
  WIRE_TAG.snapshot,
  WIRE_TAG.events,
  WIRE_TAG.checkpoint,
  WIRE_TAG.authorityChange,
])

const dropsOfTransport = new WeakMap<Transport, PeerAuthorityDrops>()

/**
 * Wraps a Transport so every INBOUND datagram is checked against `authority`
 * before any loop sees it. Everything else delegates.
 *
 * WHY THIS EXISTS. Plan 2 shipped identity by claim, deliberately, and said so
 * in its own source (authority.ts): "any peer can send a datagram naming any
 * playerId. Plan 4's lobby handshake is where reclaiming a seat gets
 * authenticated." Without this decorator, AuthorityLoop learns peerId ->
 * playerId from the datagram itself and validates nothing, so any peer in the
 * room can seize any seat - including the host's - by sending one input
 * datagram naming it, and the reclaim line will helpfully mark that seat
 * connected. On the server, any guest could forge a snapshot the shadow
 * reconciles its whole race onto.
 *
 * WHY A DECORATOR. AuthorityLoop, ClientLoop and ShadowLoop have locked public
 * shapes and none of them takes a seat map. A transport decorator is a
 * transport, `net` owns transports, and this is the shape withLocalInput
 * already established - so one implementation and one test covers both the
 * host's fan-out and the server's room transport.
 *
 * Allocation-free on the hot path: the seat check reads playerIdOfInput(data) -
 * three bits at a fixed offset - and never decodes the intent window. No
 * decodeHeader either: this runs OUTSIDE the shipped datagram guard, in front
 * of it, and decodeHeader throws on an unknown tag.
 */
export function withPeerAuthority(inner: Transport, authority: PeerAuthority): Transport {
  const drops: PeerAuthorityDrops = { wrongSeat: 0, notAuthority: 0, malformed: 0 }

  // ONE listener on `inner`, installed at construction and fanned out to
  // however many this decorator's own onMessage collects. Installing it now
  // also makes the diagnostic count every inbound refusal, even before a loop
  // subscribes. Registering a filtered listener per subscriber would
  // count each dropped datagram once per subscriber, and on a guest there are
  // two of them (ClientLoop and RoomClient) - a drop counter that reads 2 for
  // one dropped datagram is worse than no counter, because the number is what a
  // reader reasons about. Appending, never replacing: contract §2.1 rule 1.
  const cbs: ((peerId: string, channel: ChannelName, data: Uint8Array) => void)[] = []

  const dispatch = (peerId: string, channel: ChannelName, data: Uint8Array): void => {
    if (data.length < HEADER_BYTES) {
      drops.malformed++
      return
    }
    const tag = data[0]
    if (tag === WIRE_TAG.input) {
      const claimed = playerIdOfInput(data)
      if (claimed < 0) {
        // Too short to hold the claim. Counted malformed and NOT read as seat
        // 0, which is the host's.
        drops.malformed++
        return
      }
      if (claimed !== authority.playerIdOf(peerId)) {
        // playerIdOf returns -1 for a peer with no seat, and `claimed` is >= 0
        // here, so a seatless peer is refused every seat by this one comparison.
        drops.wrongSeat++
        return
      }
    } else if (AUTHORITATIVE_TAGS.has(tag)) {
      if (!authority.isAuthority(peerId)) {
        drops.notAuthority++
        return
      }
    }
    // Everything else - the lobby kinds, ping and pong - passes untouched. They
    // are the hub's to adjudicate and it has the full message; a joining guest
    // has no seat yet, so a rule that refused seatless peers here would mean
    // nobody could ever acquire one.
    for (const cb of cbs) cb(peerId, channel, data)
  }

  inner.onMessage(dispatch)

  const guarded: Transport = {
    // Outbound is never filtered: on both sides of this decorator the sender IS
    // the authority for what it sends.
    send: (channel, peerId, data) => inner.send(channel, peerId, data),
    broadcast: (channel, data) => inner.broadcast(channel, data),
    onMessage(cb) {
      cbs.push(cb)
    },
    onPeerLost: (cb) => inner.onPeerLost(cb),
    peers: () => inner.peers(),
    close: () => inner.close(),
  }

  dropsOfTransport.set(guarded, drops)
  return guarded
}

/**
 * The per-reason drop counts for a transport `withPeerAuthority` produced.
 * Throws if it did not - a silent 0 for "this object has no counter" is
 * indistinguishable from "nothing has been dropped", which is the exact
 * confusion the counter exists to prevent. Same WeakMap idiom as
 * droppedDatagramsOf (receive.ts).
 *
 * A COPY, not the live object: a diagnostic a caller can accidentally reset is
 * not a diagnostic.
 */
export function peerAuthorityDropsOf(t: Transport): PeerAuthorityDrops {
  const drops = dropsOfTransport.get(t)
  if (!drops) {
    throw new Error('peerAuthorityDropsOf: not a transport produced by withPeerAuthority')
  }
  return { ...drops }
}
