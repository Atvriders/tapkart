import { rngAt } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from './transport'

export interface LoopbackOptions {
  latencyMs: number
  jitterMs: number
  lossRate: number
  seed: number
}

type Side = 'a' | 'b'

interface PendingMessage {
  from: Side
  channel: ChannelName
  data: Uint8Array
  deliverAt: number
}

/**
 * Two Transports wired directly to each other with injected latency, jitter
 * and loss, plus a pump(nowMs) that is the only place this module reads a
 * clock: send() and broadcast() only ever see whatever nowMs the most recent
 * pump() call provided, so a test controls time completely.
 *
 * Jitter and loss are drawn from rngAt(seed, cursor) using a cursor this pair
 * owns and increments itself -- never state.rngCursor, which belongs to the
 * leader's item rolls. A transport that advanced the sim's cursor would
 * desynchronise the shadow authority.
 */
export function makeLoopbackPair(
  opts: LoopbackOptions,
): { a: Transport; b: Transport; pump(nowMs: number): void } {
  const { latencyMs, jitterMs, lossRate, seed } = opts
  let cursor = 0
  let lastNow = 0
  let aClosed = false
  let bClosed = false
  const pending: PendingMessage[] = []
  const aMessageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const bMessageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const aPeerLostCbs: Array<(peerId: string) => void> = []
  const bPeerLostCbs: Array<(peerId: string) => void> = []

  function isClosed(side: Side): boolean {
    return side === 'a' ? aClosed : bClosed
  }

  function enqueue(from: Side, channel: ChannelName, data: Uint8Array): void {
    if (channel === 'unreliable') {
      const lossRoll = rngAt(seed, cursor)
      const jitterRoll = rngAt(seed, cursor + 1)
      cursor += 2
      if (lossRoll < lossRate) return
      pending.push({ from, channel, data: data.slice(), deliverAt: lastNow + latencyMs + jitterRoll * jitterMs })
    } else {
      pending.push({ from, channel, data: data.slice(), deliverAt: lastNow + latencyMs })
    }
  }

  function makeSide(self: Side): Transport {
    const other: Side = self === 'a' ? 'b' : 'a'
    const messageCbs = self === 'a' ? aMessageCbs : bMessageCbs
    const peerLostCbs = self === 'a' ? aPeerLostCbs : bPeerLostCbs
    return {
      send(channel, peerId, data) {
        if (isClosed(self) || isClosed(other) || peerId !== other) return
        enqueue(self, channel, data)
      },
      broadcast(channel, data) {
        if (isClosed(self) || isClosed(other)) return
        enqueue(self, channel, data)
      },
      onMessage(cb) {
        messageCbs.push(cb)
      },
      onPeerLost(cb) {
        peerLostCbs.push(cb)
      },
      peers() {
        if (isClosed(self)) return []
        return isClosed(other) ? [] : [other]
      },
      close() {
        if (isClosed(self)) return
        if (self === 'a') aClosed = true
        else bClosed = true
        // One pair is one link, so closing either side invalidates every
        // datagram queued in either direction. The far side stays usable as an
        // object but has no peer, and learns about the vanished peer once.
        pending.length = 0
        if (!isClosed(other)) {
          const farPeerLostCbs = other === 'a' ? aPeerLostCbs : bPeerLostCbs
          for (const cb of [...farPeerLostCbs]) cb(self)
        }
      },
    }
  }

  const a = makeSide('a')
  const b = makeSide('b')

  function pump(nowMs: number): void {
    lastNow = nowMs
    const ready: PendingMessage[] = []
    const stillPending: PendingMessage[] = []
    for (const m of pending) {
      if (m.deliverAt <= nowMs) ready.push(m)
      else stillPending.push(m)
    }
    pending.length = 0
    for (const m of stillPending) pending.push(m)
    ready.sort((x, y) => x.deliverAt - y.deliverAt)
    for (const m of ready) {
      const destination: Side = m.from === 'a' ? 'b' : 'a'
      if (isClosed(m.from) || isClosed(destination)) continue
      const cbs = destination === 'a' ? aMessageCbs : bMessageCbs
      for (const cb of [...cbs]) cb(m.from, m.channel, m.data)
    }
  }

  return { a, b, pump }
}
