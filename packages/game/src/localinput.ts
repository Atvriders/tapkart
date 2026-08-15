// PURE — one composition, no DOM, no clock, no state of its own.
import { createNullTransport, withLocalInput } from '@tapkart/net'
import type { LocalInputTransport } from '@tapkart/net'

/**
 * A zero-peer transport wrapped with net's real local-input codec path. Solo
 * therefore drives the same AuthorityLoop, with the same input quantisation and
 * cadence, as a networked host.
 */
export function createSoloTransport(): LocalInputTransport {
  return withLocalInput(createNullTransport())
}
