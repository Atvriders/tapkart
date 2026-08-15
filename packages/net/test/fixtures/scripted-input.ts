// Deterministic per-tick input, shared by the integration tests in this plan so a reference run
// and a networked run always agree bit-for-bit on "what the player did."
import type { Intent } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import { INPUT_REDUNDANCY, encodeHeader, encodeInput } from '@tapkart/protocol'

/**
 * Smooth low-frequency sine steer, constant half-throttle, a brief periodic drift tap. No
 * `Math.random()` anywhere: two independent callers computing `scriptedIntent(tick, playerId)` for
 * the same arguments always agree, which is what makes a same-process reference run meaningful.
 *
 * NOT used by the zero-corrections measurement. A varying steer signal puts the authority's
 * latency-held copy behind the client's current value by ~one one-way trip, which is a real physics
 * difference and not quantisation noise - Task 15 measured exactly that and settled on a
 * held-steady intent for the zero-corrections invariant. This function is for the promotion and
 * late-join tests, where what matters is that two peers agree on a non-trivial trajectory, not that
 * the trajectory is noise-free.
 */
export function scriptedIntent(tick: number, playerId: number): Intent {
  const phase = tick / 97 + playerId
  return {
    tick,
    steer: Math.sin(phase) * 0.6,
    accel: 0.5,
    brake: false,
    drift: tick % 240 < 40,
    useItem: false,
  }
}

/**
 * Encodes the redundant window ending at `tick` (spec §5: "each datagram carrying the last 8
 * intents") behind the contract's shared 2-byte header and broadcasts it. Before
 * `tick >= INPUT_REDUNDANCY - 1` the window is padded by repeating the earliest available intent,
 * which is harmless: every entry in the padded region is identical to what `scriptedIntent` would
 * compute for that tick anyway.
 *
 * This is a THIN CLIENT: a seat with no ClientLoop of its own, played by the test itself, so a test
 * can put a second human on the track without a second prediction loop. The real guest in these
 * tests is a real `ClientLoop` and sends its own datagrams; this function exists for the seat beside
 * it, and for the spec §5 dual send (host AND shadow) on a topology where the test, not a loop, owns
 * both destinations.
 *
 * The header is `encodeHeader(buf, 'input')` - protocol's, shared with AuthorityLoop, ClientLoop and
 * ShadowLoop.
 */
export function broadcastScriptedInput(
  t: { broadcast(channel: ChannelName, data: Uint8Array): void },
  playerId: number,
  tick: number,
): void {
  const intents: Intent[] = []
  const first = Math.max(0, tick - INPUT_REDUNDANCY + 1)
  for (let ti = first; ti <= tick; ti++) intents.push(scriptedIntent(ti, playerId))
  while (intents.length < INPUT_REDUNDANCY) intents.unshift(scriptedIntent(first, playerId))
  const buf = new Uint8Array(256)
  const h = encodeHeader(buf, 'input')
  const n = encodeInput(buf.subarray(h), playerId, intents)
  t.broadcast('unreliable', buf.slice(0, h + n))
}
