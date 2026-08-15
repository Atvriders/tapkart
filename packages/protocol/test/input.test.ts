import { describe, expect, it } from 'vitest'
import type { Intent } from '@tapkart/sim'
import type { InputDatagram } from '../src/types'
import { quantStep } from '../src/quant'
import { INPUT_REDUNDANCY, decodeInput, encodeInput } from '../src/input'

// Deterministic per-tick intent generator. steer cycles through -1..1 in 9
// steps and accel through 0..1 in 5 steps; the three booleans use moduli that
// vary independently, so entries at different ticks generally carry
// different field values and every field actually gets exercised. Works for
// any integer tick, not just an even, uniformly-spaced sequence.
function intentAt(tick: number): Intent {
  return {
    tick,
    steer: ((tick % 9) - 4) / 4,
    accel: (tick % 5) / 4,
    brake: tick % 4 === 0,
    drift: tick % 6 === 0,
    useItem: tick % 10 === 0,
  }
}

/** 8 intents at newestTick - 14 .. newestTick, step 2, oldest first. */
function windowEndingAt(newestTick: number): Intent[] {
  const out: Intent[] = []
  for (let t = newestTick - 14; t <= newestTick; t += 2) out.push(intentAt(t))
  return out
}

function blankDatagram(): InputDatagram {
  const intents: Intent[] = []
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    intents.push({ tick: -1, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  return { playerId: -1, intents }
}

const STEER_STEP = quantStep(-1, 1, 8)
const ACCEL_STEP = quantStep(0, 1, 6)

function expectIntentRecovered(actual: Intent, expected: Intent): void {
  expect(actual.tick).toBe(expected.tick)
  expect(Math.abs(actual.steer - expected.steer)).toBeLessThan(STEER_STEP)
  expect(Math.abs(actual.accel - expected.accel)).toBeLessThan(ACCEL_STEP)
  expect(actual.brake).toBe(expected.brake)
  expect(actual.drift).toBe(expected.drift)
  expect(actual.useItem).toBe(expected.useItem)
}

describe('encodeInput / decodeInput', () => {
  it('round-trips playerId and all 8 intents within each field\'s quantization step', () => {
    const intents = windowEndingAt(114) // ticks 100..114, step 2
    const buf = new Uint8Array(32)
    const bytes = encodeInput(buf, 4, intents)

    // 3 (playerId) + 32 (baseTick) + 8 * (8 delta + 8 steer + 6 accel + 3 bools)
    // = 3 + 32 + 200 = 235 bits = 30 bytes
    expect(bytes).toBe(30)

    const out = blankDatagram()
    decodeInput(buf.subarray(0, bytes), out)

    expect(out.playerId).toBe(4)
    expect(out.intents.length).toBe(INPUT_REDUNDANCY)
    for (let i = 0; i < INPUT_REDUNDANCY; i++) {
      expectIntentRecovered(out.intents[i], intents[i])
    }
  })

  it('round-trips a window at a different offset with irregular tick spacing, reporting exactly the encoded ticks and nothing else', () => {
    // encodeInput/decodeInput are stateless per call -- there is no
    // cross-datagram memory in this file, so this test (unlike an earlier
    // version of it) makes no claim about recovering a dropped datagram's
    // ticks from a later one. That property belongs to a caller that
    // assembles overlapping windows across successive calls (ClientLoop /
    // AuthorityLoop, Task 15 / Task 14) and is proven at the integration
    // level in Task 17, against a transport that actually drops packets.
    //
    // What this test proves instead: a window at a different base tick and
    // playerId than test 1's, AND with irregular (non-uniform) spacing
    // between entries -- 3, 6, 1, 8, 7, 5, 10 apart rather than a constant
    // 2 -- round-trips correctly. The irregular deltas matter: with the
    // uniform 2-tick spacing test 1 uses, an encoder/decoder that hardcoded
    // a fixed per-entry step instead of reading/writing each entry's own
    // stored tickDelta would still pass. Only a genuinely variable spacing
    // can catch that. And because out.intents has exactly INPUT_REDUNDANCY
    // entries drawn 1:1 from the decoded tickDelta fields, the exact tick-list
    // equality below also shows decode reports precisely the encoded window --
    // no placeholder tick (blankDatagram's sentinel -1) survives, and no tick
    // outside the 8 that were encoded appears.
    const ticks = [200, 203, 209, 210, 218, 225, 230, 240] // oldest first, irregular gaps
    const intents = ticks.map(intentAt)
    const buf = new Uint8Array(32)
    const bytes = encodeInput(buf, 7, intents)
    expect(bytes).toBe(30)

    const out = blankDatagram()
    decodeInput(buf.subarray(0, bytes), out)

    expect(out.playerId).toBe(7)
    expect(out.intents.map((iv) => iv.tick)).toEqual(ticks)
    for (let i = 0; i < INPUT_REDUNDANCY; i++) {
      expectIntentRecovered(out.intents[i], intents[i])
    }
  })
})
