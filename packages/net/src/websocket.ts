import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from './transport'
import type { SocketLike } from './socket'
import { WS_CLOSE_BACKPRESSURE } from './socket'
import {
  WS_CONTROL_PEER_GONE,
  WS_CONTROL_PEER_JOINED,
  WS_FRAME_CONTROL,
  WS_FRAME_DATA,
  WS_HEADER_BYTES,
  WS_SLOT_BROADCAST,
  WS_SLOT_SERVER,
  decodeWsFrame,
  encodeWsData,
} from './wsframe'

/**
 * PURE (contract §0a): one socket, many peers behind it, and no WebSocket named
 * anywhere in this file. The client-side transport.
 *
 * Above this bufferedAmount the socket is not writable and unreliable traffic
 * goes to the mailbox instead (F-P4-44).
 */
export const WS_MAX_BUFFERED_BYTES = 1 << 20
/**
 * A reliable backlog past this is not survivable: reliable traffic is never
 * dropped, so the only remaining options are unbounded memory on a shared
 * server process or closing one socket. We close it.
 */
export const WS_MAX_RELIABLE_BUFFERED_BYTES = 4 << 20

export interface WebSocketTransportOptions {
  socket: SocketLike
  /** This endpoint's own slot, from WelcomeMessage.peerSlot. Frames whose origin
   *  equals it are dropped: a relay must never echo a peer to itself. Omitted
   *  while the welcome that assigns the slot is still in flight. */
  selfSlot?: number
  /** Slot -> stable peer id. Default `(s) => 'p' + s`; the server's room
   *  transport passes its own so ids match across both ends of a test. */
  peerIdOfSlot?: (slot: number) => string
  maxBufferedBytes?: number
}

export interface WebSocketTransport extends Transport {
  /** Assign the slot learned from WelcomeMessage exactly once. */
  setSelfSlot(slot: number): void
  /** Signalling rides text frames on the same socket (§4.4). */
  sendText(text: string): void
  onText(cb: (text: string) => void): void
  /** Unreliable datagrams superseded in the mailbox before they were ever sent.
   *  0 in the steady state; non-zero only under a stalled socket, which is the
   *  only visible symptom of back-pressure. */
  droppedUnreliable(): number
  /** Unreliable datagrams currently held, waiting for the socket to drain. */
  mailboxDepth(): number
  knownSlots(): number[]
}

interface MailboxEntry {
  slot: number
  frame: Uint8Array
}

export function makeWebSocketTransport(opts: WebSocketTransportOptions): WebSocketTransport {
  const socket = opts.socket
  let selfSlot: number | null = opts.selfSlot ?? null
  const validSelfSlot = (slot: number): boolean =>
    Number.isInteger(slot) && slot > WS_SLOT_SERVER && slot < WS_SLOT_BROADCAST
  if (selfSlot !== null && !validSelfSlot(selfSlot)) {
    throw new RangeError(`makeWebSocketTransport: invalid self slot ${selfSlot}`)
  }
  const peerIdOfSlot = opts.peerIdOfSlot ?? ((s: number): string => `p${s}`)
  const maxBufferedBytes = opts.maxBufferedBytes ?? WS_MAX_BUFFERED_BYTES

  const messageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const peerLostCbs: Array<(peerId: string) => void> = []
  const textCbs: Array<(text: string) => void> = []

  /** Learned from inbound control frames ONLY, in the order they were learned. */
  const slots: number[] = []
  const slotOfPeerId = new Map<string, number>()
  const mailbox = new Map<string, MailboxEntry>()
  let droppedUnreliable = 0
  let closed = false

  const serverPeerId = peerIdOfSlot(WS_SLOT_SERVER)
  slotOfPeerId.set(serverPeerId, WS_SLOT_SERVER)

  function frameFor(channel: ChannelName, slot: number, data: Uint8Array): Uint8Array {
    // A fresh buffer per frame, not a shared scratch: `socket.send` may hold the
    // bytes until the socket drains, and the mailbox holds them for longer than
    // that. One copy of at most 749 B (§3.6's largest unreliable datagram).
    const frame = new Uint8Array(WS_HEADER_BYTES + data.length)
    encodeWsData(frame, channel, slot, data)
    return frame
  }

  function flushMailbox(): void {
    if (mailbox.size === 0) return
    if (socket.bufferedAmount() > maxBufferedBytes) return
    // Map iteration is insertion order, and replacing a value keeps the key's
    // original position - so the oldest held datagram goes out first carrying
    // the newest bytes for its (slot, tag).
    const entries = [...mailbox.values()]
    mailbox.clear()
    for (const e of entries) socket.send(e.frame)
  }

  function sendFrame(channel: ChannelName, slot: number, data: Uint8Array): void {
    if (closed) return
    // There is no drain callback on SocketLike and this transport reads no
    // clock, so every send and every inbound message is a pump. At 20 Hz
    // snapshots and 30 Hz inputs one is never far away.
    flushMailbox()

    if (channel === 'reliable') {
      if (socket.bufferedAmount() > WS_MAX_RELIABLE_BUFFERED_BYTES) {
        closeInternal(WS_CLOSE_BACKPRESSURE)
        return
      }
      socket.send(frameFor(channel, slot, data))
      return
    }

    if (socket.bufferedAmount() > maxBufferedBytes) {
      // Latest wins, depth 1 per (slot, tag). EXACTLY ONE byte of the payload is
      // read - payload[0], the tag encodeHeader wrote - and only to key the
      // mailbox, so a ping is never displaced by a snapshot. Nothing is decoded.
      //
      // Replacement is lossless in the sense that matters, and only because
      // every unreliable message in this system is self-superseding: a snapshot
      // is a complete state, an input datagram carries an 8-tick redundant
      // window, and a ping is a probe whose whole design tolerates loss. A
      // future unreliable kind that is NOT self-superseding makes this mailbox
      // wrong for it, and the mailbox is what changes.
      const tag = data.length > 0 ? data[0] : -1
      const key = `${slot}:${tag}`
      if (mailbox.has(key)) droppedUnreliable++
      mailbox.set(key, { slot, frame: frameFor(channel, slot, data) })
      return
    }

    socket.send(frameFor(channel, slot, data))
  }

  function firePeerLost(slot: number): void {
    const peerId = peerIdOfSlot(slot)
    slotOfPeerId.delete(peerId)
    for (const cb of [...peerLostCbs]) cb(peerId)
  }

  function closeInternal(code?: number): void {
    if (closed) return
    // `closed` FIRST, then the socket: the socket's own onClose fires
    // synchronously from close(), and rule 5 says nothing is delivered after
    // close() - including onPeerLost callbacks for a teardown we asked for.
    closed = true
    slots.length = 0
    slotOfPeerId.clear()
    mailbox.clear()
    socket.close(code)
  }

  socket.onMessage((data) => {
    if (closed) return
    if (typeof data === 'string') {
      for (const cb of [...textCbs]) cb(data)
      return
    }

    flushMailbox()

    const frame = decodeWsFrame(data)
    // A DATAGRAM THAT CANNOT BE DECODED IS A DATAGRAM THAT NEVER ARRIVED.
    // decodeWsFrame returns null rather than throwing, so the next frame on this
    // socket is still processed and one malformed frame never takes a room down.
    if (frame === null) return

    if (frame.frameKind === WS_FRAME_CONTROL) {
      if (selfSlot !== null && frame.peerSlot === selfSlot) return
      if (frame.controlOp === WS_CONTROL_PEER_JOINED) {
        if (!slots.includes(frame.peerSlot)) {
          slots.push(frame.peerSlot)
          slotOfPeerId.set(peerIdOfSlot(frame.peerSlot), frame.peerSlot)
        }
        return
      }
      if (frame.controlOp === WS_CONTROL_PEER_GONE) {
        const at = slots.indexOf(frame.peerSlot)
        // Only for a slot this transport actually holds, which is what makes
        // onPeerLost fire EXACTLY once for a repeated PEER_GONE.
        if (at < 0) return
        slots.splice(at, 1)
        firePeerLost(frame.peerSlot)
      }
      return
    }

    if (frame.frameKind !== WS_FRAME_DATA || frame.channel === null) return
    // A relay must never echo a peer to itself.
    if (selfSlot !== null && frame.peerSlot === selfSlot) return
    // Delivered, but NOT learned: the slot table is written by control frames
    // only. An unknown origin is a routing bug, and silently learning it hides
    // one.
    const peerId = peerIdOfSlot(frame.peerSlot)
    for (const cb of [...messageCbs]) cb(peerId, frame.channel, frame.payload)
  })

  socket.onClose(() => {
    if (closed) return
    // Every peer behind this socket is unreachable, including the room itself.
    // Without this an AuthorityLoop keeps every relayed guest's kart frozen
    // instead of bot-driving it, and the conformance harness's dropB() - which
    // for this transport IS the socket dying - could observe nothing at all.
    const lost = [WS_SLOT_SERVER, ...slots]
    closed = true
    slots.length = 0
    slotOfPeerId.clear()
    mailbox.clear()
    for (const slot of lost) {
      for (const cb of [...peerLostCbs]) cb(peerIdOfSlot(slot))
    }
  })

  return {
    setSelfSlot(slot: number): void {
      if (!validSelfSlot(slot)) {
        throw new RangeError(`setSelfSlot: invalid self slot ${slot}`)
      }
      if (selfSlot !== null) {
        throw new Error(`setSelfSlot: self slot already set to ${selfSlot}`)
      }
      selfSlot = slot
      // A server that announced this peer before welcome may have put it in the
      // learned table while its identity was unknowable. Remove it now so the
      // transport never addresses or reports itself as a remote peer.
      const at = slots.indexOf(slot)
      if (at >= 0) slots.splice(at, 1)
      slotOfPeerId.delete(peerIdOfSlot(slot))
    },
    send(channel, peerId, data): void {
      const slot = slotOfPeerId.get(peerId)
      // An unknown peer is a no-op, not a throw (Transport rule 4).
      if (slot === undefined) return
      sendFrame(channel, slot, data)
    },
    broadcast(channel, data): void {
      // ONE frame, addressed to the broadcast slot. The server fans it out.
      sendFrame(channel, WS_SLOT_BROADCAST, data)
    },
    onMessage(cb): void {
      messageCbs.push(cb)
    },
    onPeerLost(cb): void {
      peerLostCbs.push(cb)
    },
    peers(): string[] {
      if (closed) return []
      // The room itself is always a peer, from CONSTRUCTION and not from the
      // first frame: RoomClient sends `hello` to the server before any frame has
      // ever arrived, and a transport with no peers yet would silently drop it
      // and hang the join forever.
      return [serverPeerId, ...slots.map(peerIdOfSlot)]
    },
    close(): void {
      closeInternal()
    },
    sendText(text): void {
      if (closed) return
      flushMailbox()
      socket.send(text)
    },
    onText(cb): void {
      textCbs.push(cb)
    },
    droppedUnreliable(): number {
      return droppedUnreliable
    },
    mailboxDepth(): number {
      return mailbox.size
    },
    knownSlots(): number[] {
      return [...slots]
    },
  }
}
