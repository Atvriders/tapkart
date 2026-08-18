import type { EntityKind, Intent, ItemKind, RacePhase, Surface, Vec3 } from '@tapkart/sim'

/**
 * TWO, not one, and the bump is not optional.
 *
 * ROOM_CODE_LENGTH went 4 -> 5 (F-P4-34), which moves every field after
 * `hello`'s room code by five bits. That is a BREAKING wire change: a v1 peer
 * and a v2 peer decode different messages out of the same bytes, and both of
 * them find something plausible there. F-P4-11's "adding tags is additive" is
 * true of `clientUpdate` and `resyncRequest` and false of the room code, and
 * the two land in the same release.
 *
 * `decodeHeader` below throws on a mismatch and @tapkart/net's shipped guard
 * turns that into a counted, dropped datagram - which is right everywhere
 * except for `hello`, where a silent drop is a player watching a spinner
 * forever. The server therefore reads `data[1]` DIRECTLY, before the guard
 * (contract §3.0), and closes the socket with WS_CLOSE_VERSION_MISMATCH = 4001.
 * A close code crosses a version boundary; an encoded `welcome` does not.
 *
 * The byte's offset is what makes that legal: index 1, in a fixed-format 2-byte
 * header, for every kind and every version this protocol will ever have.
 */
export const PROTOCOL_VERSION = 2

export type ChannelName = 'unreliable' | 'reliable'

/**
 * `clientUpdate` and `resyncRequest` are Task 15c item D, and they are additive:
 * no existing message's bit layout changes.
 *
 * Everything a client says outside of input used to ride on `hello` - ready
 * toggles, character changes, track choice, start, resync requests, seat
 * reclaims - so every handler had to distinguish intent by INSPECTING FIELDS of
 * a decoded body rather than by dispatching on the tag byte that exists for
 * exactly that. The MessageKind -> handler table is already the top-ranked
 * shared-name risk in this plan; one overloaded kind carrying six unrelated
 * meanings is how that risk becomes a defect.
 *
 * Plan 4 defines the BODIES. This task adds the tags and nothing else, so that
 * the tag table is settled before two plans invent two incompatible answers.
 */
export type MessageKind =
  | 'hello' | 'welcome' | 'lobby' | 'start' | 'clientUpdate'
  | 'input' | 'snapshot' | 'events' | 'checkpoint' | 'resyncRequest'
  | 'authorityChange' | 'ping' | 'pong'

export interface WireHeader { kind: MessageKind; protocolVersion: number }

// Every datagram begins with this byte, so a receiver can dispatch before
// decoding anything else. Without a shared tag, Tasks 11/14/15/16 would each
// invent their own -- which is exactly what happened when this was left
// unspecified in an earlier draft of this contract.
//
// Grouped by nibble: 0x0x is lobby/session traffic, 0x1x is in-race data, 0x2x
// is authority migration, 0x3x is liveness. clientUpdate joins the lobby group
// and resyncRequest the in-race group, each in the next free slot of its own
// group -- no existing value moves, so a peer built before this change still
// decodes every message it already understood.
export const WIRE_TAG = {
  hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04, clientUpdate: 0x05,
  input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13, resyncRequest: 0x14,
  authorityChange: 0x20, ping: 0x30, pong: 0x31,
} as const

const TAG_TO_KIND = ((): ReadonlyMap<number, MessageKind> => {
  const m = new Map<number, MessageKind>()
  for (const kind of Object.keys(WIRE_TAG) as MessageKind[]) {
    m.set(WIRE_TAG[kind], kind)
  }
  return m
})()

/** Writes [tag, PROTOCOL_VERSION] into out[0..1] and returns 2, the byte count. */
export function encodeHeader(out: Uint8Array, kind: MessageKind): number {
  out[0] = WIRE_TAG[kind]
  out[1] = PROTOCOL_VERSION
  return 2
}

/**
 * Reads the 2-byte header written by encodeHeader. Throws on an unrecognised
 * tag byte or a PROTOCOL_VERSION that does not match this build's.
 */
export function decodeHeader(buf: Uint8Array): WireHeader {
  const tag = buf[0]
  const kind = TAG_TO_KIND.get(tag)
  if (kind === undefined) {
    throw new Error(`decodeHeader: unknown wire tag ${tag}`)
  }
  const protocolVersion = buf[1]
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `decodeHeader: protocol version mismatch (expected ${PROTOCOL_VERSION}, got ${protocolVersion})`,
    )
  }
  return { kind, protocolVersion }
}

export interface WireKart {
  playerId: number; position: Vec3; velocity: Vec3; heading: number
  angularVelocity: number; driftCharge: number; driftActive: boolean
  driftDir: -1 | 0 | 1; airborne: boolean; surface: Surface
  spinOutTicks: number; invulnTicks: number; item: ItemKind
  lap: number; checkpointIdx: number; t: number
  isBot: boolean; connected: boolean
  boostTicks: number; respawnTicks: number; shielded: boolean
}

export interface WireEntity {
  entityId: number; kind: EntityKind; ownerId: number
  position: Vec3; velocity: Vec3; heading: number; ttl: number
}

/**
 * `phase` is Task 15c item A: 2 bits, in the HEADER, once per snapshot.
 *
 * It is a header field and not a 23rd column of WireKart because spec §5 states
 * the per-kart record's invariant in so many words - "the per-kart record is a
 * complete projection of every field in SimState's kart struct; a field absent
 * from this table cannot exist in the kart struct" - and `phase` lives on
 * SimState, not on KartState. Encoding it once per kart would also put eight
 * copies of one global value on the wire, which is a format that can express
 * eight karts disagreeing about whether the race has started.
 *
 * Without it a guest can never be told the race has NOT started: ClientLoop
 * forced `phase = 'racing'` at construction precisely because the wire carried
 * no answer, so every guest drove away while the host was still counting down.
 */
export interface WireSnapshot {
  tick: number; eventSeq: number
  phase: RacePhase
  lastProcessedInputTick: number[]      // length MAX_KARTS
  karts: WireKart[]                     // length MAX_KARTS
  entities: WireEntity[]                // length MAX_ENTITIES, live packed at front
  entityCount: number
}

export interface InputDatagram {
  playerId: number; intents: Intent[]   // length INPUT_REDUNDANCY, newest last
}
