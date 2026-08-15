import type { Intent } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import { INPUT_REDUNDANCY, encodeHeader, encodeInput } from '@tapkart/protocol'
import type { Transport } from './transport'

/**
 * The peerId every locally-submitted input datagram arrives under. A constant so
 * a loop's peerId -> playerId map (AuthorityLoop's, ShadowLoop's) can tell the
 * host's own seat from a remote one without inventing a name per call site.
 */
export const LOCAL_PEER_ID = 'local'

/** Same reasoning as ClientLoop's send buffer: 8 small intents plus the 2-byte
 * message header, far under this. */
const SEND_BUF_BYTES = 256

/**
 * 60Hz sim / 30Hz wire = exact 2. The same constant ClientLoop applies to its own
 * sends, and the same rule: a datagram goes out on EVEN ticks only.
 *
 * Spec §5 fixes client input at 30Hz ("input intents at 30Hz, each datagram
 * carrying the last 8 intents"), and the authority holds the newest intent
 * across both ticks of the pair. This decorator used to impose no cadence at
 * all, so a host submitting every tick fed itself 60Hz input against every
 * guest's 30Hz - twice the steering granularity, and drift timing quantised to
 * one tick instead of the two the mini-turbo tier thresholds are defined in
 * multiples of.
 *
 * That defeats the point of this decorator, which exists so the host does not
 * drive a measurably different car: quantisation parity was achieved and
 * measured, and TEMPORAL parity was not. It is enforced here rather than left to
 * the caller precisely because the caller that gets it wrong (Plan 3's
 * composition root, copying an every-tick example) would gain a quiet advantage
 * that no test of a guest could see.
 */
const INPUT_SEND_INTERVAL_TICKS = 2

/**
 * A Transport with no peers at all: sends and broadcasts go nowhere, no callback
 * ever fires, `peers()` is empty.
 *
 * This exists because a host playing solo, or a host whose room has not filled
 * yet, still needs a Transport to hand its AuthorityLoop - and the only other
 * one in this package is `makeLoopbackPair`, which mints a PAIR. Handing an
 * AuthorityLoop one side of an un-pumped pair looks like it works and quietly
 * queues every snapshot the race ever broadcasts: ~3,600 of them at 20Hz over
 * three minutes, each a fresh Uint8Array, none ever delivered or freed.
 */
export function createNullTransport(): Transport {
  return {
    send() {},
    broadcast() {},
    onMessage() {},
    onPeerLost() {},
    peers(): string[] {
      return []
    },
    close() {},
  }
}

export interface LocalInputTransport extends Transport {
  /**
   * Submits one local intent for `playerId`, delivering it to this transport's
   * own message callbacks as a real input datagram from LOCAL_PEER_ID.
   *
   * CALL IT EVERY TICK. It applies the 30Hz wire cadence itself and sends on the
   * even ticks only, exactly as a guest's ClientLoop does (spec §5: input at 30Hz
   * into a 60Hz sim, the authority holding the newest intent across both ticks of
   * the pair). A caller that imposed its own cadence on top would halve it again;
   * one that called every tick and got 60Hz through would be handing the host
   * twice a guest's steering granularity.
   *
   * An odd tick is not DISCARDED, though - its `brake`, `drift` and `useItem` are
   * OR-ed into the datagram the next even tick sends (Task 15c item D). See the
   * latch in the body.
   *
   * `intent.tick` is the tick the intent belongs to and must advance across
   * calls, exactly as a remote client's does - the receiving loop keeps only
   * intents newer than the one it holds, and this decorator reads the same field
   * to decide which ticks go on the wire.
   */
  submitLocalInput(playerId: number, intent: Intent): void
}

/**
 * Wraps a Transport so the host can drive its own kart.
 *
 * NOTHING in this plan otherwise lets it: AuthorityLoop's only input source is
 * `onMessage`, so a host with an AuthorityLoop and no decorator has a kart that
 * nobody is driving.
 *
 * The submitted intent goes through the REAL encodeInput/decodeInput codec - the
 * bytes are encoded here and decoded by the receiving loop - rather than being
 * handed over as an object. That is the entire point, not ceremony: encodeInput
 * quantises steer to 8 bits over [-1, 1] and accel to 6 bits over [0, 1], and a
 * host that skipped it would drive a measurably DIFFERENT car from every guest,
 * on the same track, in the same race. The magnitude is not theoretical: Task 15
 * measured 186 corrections per 600 ticks from exactly this mismatch on the
 * client side, where a steady steer of 0.15 (not on the 8-bit grid; the nearest
 * code dequantises to 0.14902) pulled a predicted kart 0.05-0.07 m/s away from
 * the authority's in 20-40 ticks.
 *
 * Delivery is synchronous and lossless, which is correct: there is no network
 * between a host and its own hands.
 *
 * `peers()` passes through unchanged and never reports LOCAL_PEER_ID: the local
 * player is not a peer, and a loop that treated it as one would, for instance,
 * expect to lose it.
 */
export function withLocalInput(t: Transport): LocalInputTransport {
  const messageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const buf = new Uint8Array(SEND_BUF_BYTES)

  // The same 8-entry redundant window a ClientLoop sends, so what the receiving
  // loop decodes has the shape it decodes from everyone else.
  const window: Intent[] = []
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    window.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  let primed = false
  /**
   * The boolean fields, OR-ed across the odd ticks this decorator does not send
   * on, and cleared the moment they are sent (Task 15c item D).
   *
   * This decorator dropped odd ticks outright, by the same parity rule
   * ClientLoop's send path uses - so it lost item presses in exactly the same
   * way, and Plan 3 ruled `useItem` a one-tick pulse emitted on press. Half of a
   * HOST's item uses went nowhere, and the host has no network to blame it on.
   *
   * `steer` and `accel` are deliberately not latched: they are continuous, the
   * newest value is the right one, and OR has no meaning for a number. The wider
   * analog sampling mismatch this leaves in place is a known, measured, declined
   * fix - see the same latch in `client.ts` for the measurement and the ruling.
   */
  let latchedBrake = false
  let latchedDrift = false
  let latchedUseItem = false
  /** Reused scratch: the intent as it goes on the wire, assembled once per send.
   * Never retained - `copyIntent` writes it into the window field by field. */
  const latchedIntent: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }

  return {
    send(channel, peerId, data) {
      t.send(channel, peerId, data)
    },
    broadcast(channel, data) {
      t.broadcast(channel, data)
    },
    onMessage(cb) {
      // Registered on BOTH: the wrapped transport delivers whatever the network
      // delivers, and this list is what submitLocalInput delivers to. The two
      // never double-deliver the same datagram.
      messageCbs.push(cb)
      t.onMessage(cb)
    },
    onPeerLost(cb) {
      // Straight through: the local player is not a peer and cannot be lost.
      t.onPeerLost(cb)
    },
    peers() {
      return t.peers()
    },
    close() {
      t.close()
    },
    submitLocalInput(playerId: number, intent: Intent): void {
      // The 30Hz cadence, keyed on the intent's own tick and not on a private
      // call counter: a guest sends on even ticks (ClientLoop's
      // `predicted.tick % INPUT_SEND_INTERVAL_TICKS === 0`), so a host keyed the
      // same way puts its intents on the wire at the same instants, with the
      // same 2-tick spacing inside the redundant window. A call counter would
      // drift out of phase the first time a caller skipped a tick.
      // Latched before the cadence gate, so a press on a tick that is not sent
      // is still in hand when the next even tick comes round. Every call
      // contributes; only a send clears.
      if (intent.brake === true) latchedBrake = true
      if (intent.drift === true) latchedDrift = true
      if (intent.useItem === true) latchedUseItem = true

      if (intent.tick % INPUT_SEND_INTERVAL_TICKS !== 0) return

      // What actually goes on the wire: this intent's analog fields, since the
      // newest value is the right one for a continuous signal, with the three
      // event fields taken from the latch. Assembled in a reused scratch object
      // rather than in the window, because the priming branch below writes the
      // SAME entry into all eight slots and a receiver reading a window of eight
      // equal ticks keeps the FIRST one it sees, not the last (AuthorityLoop's
      // `it.tick > heldIntentTick` is a strict comparison) - so patching only
      // `window[7]` would silently lose the latch on the very first datagram.
      copyIntent(intent, latchedIntent)
      latchedIntent.brake = latchedBrake
      latchedIntent.drift = latchedDrift
      latchedIntent.useItem = latchedUseItem
      // Cleared here and nowhere else, so one press travels once: a latch that
      // accumulated without clearing would leave `useItem` true for the rest of
      // the race and spend every later item on the tick it was granted.
      latchedBrake = false
      latchedDrift = false
      latchedUseItem = false

      if (!primed) {
        // The whole window starts at this intent's tick rather than at 0.
        // encodeInput writes each entry's distance behind the newest tick in 8
        // bits, so a window still holding tick-0 entries when the race is at
        // tick 300 would encode a delta of 300 into 8 bits and hand the receiver
        // eight garbage ticks.
        for (const slot of window) copyIntent(latchedIntent, slot)
        primed = true
      } else {
        for (let i = 0; i + 1 < window.length; i++) copyIntent(window[i + 1], window[i])
        copyIntent(latchedIntent, window[window.length - 1])
      }
      const h = encodeHeader(buf, 'input')
      const n = encodeInput(buf.subarray(h), playerId, window)
      // slice, not subarray: a receiver is entitled to hold what it is handed,
      // and this buffer is rewritten on the next call.
      const data = buf.slice(0, h + n)
      for (const cb of messageCbs) cb(LOCAL_PEER_ID, 'unreliable', data)
    },
  }
}

function copyIntent(src: Intent, dst: Intent): void {
  dst.tick = src.tick
  dst.steer = src.steer
  dst.accel = src.accel
  dst.brake = src.brake
  dst.drift = src.drift
  dst.useItem = src.useItem
}
