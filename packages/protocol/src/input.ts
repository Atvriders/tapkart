import type { Intent } from '@tapkart/sim'
import type { InputDatagram } from './types'
import { BitReader, BitWriter } from './bits'

/**
 * How many recent intents each input datagram carries. Spec §5: input
 * intents are produced at 30Hz and sent with the last 8, so at 60Hz sim /
 * 30Hz input a fresh datagram overlaps the previous one by 7 of its 8
 * entries. A single dropped datagram costs nothing -- every intent it would
 * have carried reappears in the next one, and the one after that, for as long
 * as it stays inside this 8-entry sliding window.
 */
export const INPUT_REDUNDANCY = 8

const PLAYER_ID_BITS = 3    // 0..7, MAX_KARTS
const TICK_BITS = 32        // baseTick: the newest intent's absolute tick, u32
const TICK_DELTA_BITS = 8   // baseTick - intent.tick; 0..14 in the steady
                             // 2-tick cadence this window assumes, 0..255
                             // representable -- far more headroom than needed
const STEER_BITS = 8        // steer -1..1: absent from quant.ts's frozen §4
                             // table (that table is WireSnapshot fields only),
                             // so this file owns its own quantisation width
const ACCEL_BITS = 6        // accel 0..1: same reasoning

/**
 * Encodes `playerId` plus the 8-entry intent window into `out`, oldest first,
 * matching `intents`' own array order (`InputDatagram.intents` is "newest
 * last"). Only the newest intent's tick is written in full (32 bits); every
 * other entry stores its distance behind that tick in 8 bits, which is
 * lossless for any window spanning up to 255 ticks -- eighteen times the
 * 14-tick span an 8-entry, 2-tick-cadence window ever produces.
 *
 * Returns the number of bytes written.
 */
export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number {
  const w = new BitWriter(out)
  w.writeBits(playerId, PLAYER_ID_BITS)
  const baseTick = intents[INPUT_REDUNDANCY - 1].tick
  w.writeBits(baseTick, TICK_BITS)
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    const intent = intents[i]
    w.writeBits(baseTick - intent.tick, TICK_DELTA_BITS)
    w.writeFloatQ(intent.steer, -1, 1, STEER_BITS)
    w.writeFloatQ(intent.accel, 0, 1, ACCEL_BITS)
    w.writeBits(intent.brake ? 1 : 0, 1)
    w.writeBits(intent.drift ? 1 : 0, 1)
    w.writeBits(intent.useItem ? 1 : 0, 1)
  }
  return w.byteLength()
}

/**
 * Decodes `buf` into the caller-owned `out`. `out.intents` must already be an
 * array of length INPUT_REDUNDANCY (any prior Intent values -- every field is
 * overwritten in place; nothing is allocated here). Mirrors encodeInput's
 * field order exactly.
 */
export function decodeInput(buf: Uint8Array, out: InputDatagram): void {
  const r = new BitReader(buf)
  out.playerId = r.readBits(PLAYER_ID_BITS)
  const baseTick = r.readBits(TICK_BITS)
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    const intent = out.intents[i]
    intent.tick = baseTick - r.readBits(TICK_DELTA_BITS)
    intent.steer = r.readFloatQ(-1, 1, STEER_BITS)
    intent.accel = r.readFloatQ(0, 1, ACCEL_BITS)
    intent.brake = r.readBits(1) !== 0
    intent.drift = r.readBits(1) !== 0
    intent.useItem = r.readBits(1) !== 0
  }
}
