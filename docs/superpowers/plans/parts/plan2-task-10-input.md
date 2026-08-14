### Task 10: `packages/protocol/src/input.ts` — input datagram codec

Encodes and decodes the 30Hz input datagram a client sends to both the host
authority and the server shadow: `playerId` plus a sliding window of the last
`INPUT_REDUNDANCY` intents, newest last. Spec §5: *"Input intents at 30Hz, each
datagram carrying the last 8 intents. Redundancy is free at this size, so a
dropped packet costs nothing."*

**Why redundancy makes a dropped packet free.** The sim runs at 60Hz; input is
produced at 30Hz, i.e. once every 2 ticks. Each datagram doesn't just carry the
newest intent — it carries the newest **8**, oldest first, newest last. If one
datagram is lost, the next one still contains every tick the lost one carried
(they overlap by 7 of 8 entries), plus one new tick. A receiver that missed the
*previous two* datagrams in a row still recovers every one of their ticks from
the third, as long as those ticks are still inside the 8-entry window — a tick
only becomes truly unrecoverable once it ages out of every subsequent window.
This task's second test drops two datagrams outright (never decodes them) and
proves every tick they carried is still readable from a third, later datagram —
except the ticks old enough to have already fallen out of that later window,
which is the window's honest edge, not a bug.

**Files:**
- Create: `packages/protocol/src/input.ts`
- Test: `packages/protocol/test/input.test.ts`

**Interfaces:**

- Consumes (already exist by the time this task runs — Tasks 3–9 precede it —
  do not redefine):
  - `packages/sim/src/types.ts`, via the `@tapkart/sim` package specifier
    (`packages/sim`'s barrel is complete and merged; this is a normal package
    import, not a relative reach-around). Verified by reading the file
    directly: `export interface Intent { tick: number; steer: number /*
    -1..1 */; accel: number /* 0..1 */; brake: boolean; drift: boolean;
    useItem: boolean }`. Field order as shown.
  - `packages/protocol/src/types.ts` [Task 3], same package, relative import
    `'./types'` — `export interface InputDatagram { playerId: number;
    intents: Intent[] /* length INPUT_REDUNDANCY, newest last */ }`. This is
    the contract's decode target (§3): **do not** declare a local
    `InputDatagram` in this file, import the one Task 3 defines.
  - `packages/protocol/src/bits.ts` [Task 4], relative import `'./bits'`:
    ```ts
    export class BitWriter {
      constructor(buf: Uint8Array)
      reset(): void
      writeBits(value: number, bits: number): void
      writeFloatQ(value: number, min: number, max: number, bits: number): void
      byteLength(): number
    }
    export class BitReader {
      constructor(buf: Uint8Array)
      reset(): void
      readBits(bits: number): number
      readFloatQ(min: number, max: number, bits: number): number
    }
    ```
  - `packages/protocol/src/quant.ts` [Task 5], relative import `'./quant'`,
    **test-file only**: `export function quantStep(min: number, max: number,
    bits: number): number`. This task's production code never calls it — see
    below.

- Produces:
  - `export const INPUT_REDUNDANCY = 8`
  - `export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number` — bytes written.
  - `export function decodeInput(buf: Uint8Array, out: InputDatagram): void` — `out.intents` must already be an array of length `INPUT_REDUNDANCY` (any prior `Intent` values; every field is overwritten). Matches the "codecs never allocate" convention: the caller owns both buffers.

- **A design decision this task must make and own:** the contract's §4
  quantisation table (`Q`/`EPS` in `quant.ts`, Task 5, frozen) covers exactly
  the `WireSnapshot` fields — position, velocity, heading, and so on. `Intent`
  is a different struct on a different channel and appears nowhere in that
  table. `steer` and `accel` therefore have **no** contract-assigned bit width
  or step; this file defines its own (`STEER_BITS`, `ACCEL_BITS` below),
  local to `input.ts`, not added to `quant.ts`'s frozen table. `quantStep` is
  still useful — the *test* uses it to compute the tolerance band for the
  round-trip assertions, since `quantStep(min, max, bits) = (max - min) /
  (2**bits - 1)` is a general formula, not one of the frozen per-field
  constants.

- **Wire layout this task defines** (LSB-first within each byte, per the
  contract's global bit-packing convention, and delegated entirely to
  `BitWriter`/`BitReader` — this file never touches bytes directly):

  | Field | Bits | Notes |
  |---|---|---|
  | `playerId` | 3 | 0..7, matches `MAX_KARTS = 8` |
  | `baseTick` | 32 | the **newest** intent's tick (`intents[INPUT_REDUNDANCY - 1].tick`), absolute, matching the `u32` width `WireSnapshot`'s own `tick` header field uses elsewhere in this package |
  | per intent, ×8, oldest to newest (matching `intents`' own array order) | | |
  | — `tickDelta` | 8 | `baseTick - intent.tick`; 0 for the newest entry, 14 for the oldest in the steady 2-tick cadence — 8 bits covers up to 255, far more headroom than the window ever needs |
  | — `steer` | 8 | `writeFloatQ(steer, -1, 1, 8)` |
  | — `accel` | 6 | `writeFloatQ(accel, 0, 1, 6)` |
  | — `brake`, `drift`, `useItem` | 1 each | |

  Total: `3 + 32 + 8 × (8 + 8 + 6 + 1 + 1 + 1) = 3 + 32 + 8×25 = 235` bits =
  `⌈235 / 8⌉ = 30` bytes. This byte count is a mathematical consequence of the
  bit widths chosen above, not an assumption about how Task 4 rounds — any
  `BitWriter` whose `byteLength()` means "bytes touched so far" (the only
  sensible reading of that signature over a `Uint8Array`) returns 30 here.

---

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/input.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Intent } from '@tapkart/sim'
import type { InputDatagram } from '../src/types'
import { quantStep } from '../src/quant'
import { INPUT_REDUNDANCY, decodeInput, encodeInput } from '../src/input'

// Deterministic per-tick intent generator. steer cycles through -1..1 in 9
// steps and accel through 0..1 in 5 steps; the three booleans use moduli that
// vary independently across an all-even tick sequence (this window's 2-tick
// production cadence never emits an odd tick), so no two of the 8 entries
// built below are identical, and every field actually gets exercised.
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

  it('recovers every tick still inside the window from a later datagram, even after two datagrams are dropped entirely', () => {
    // Three datagrams a real 30Hz sender produces back to back: newest tick
    // 14, then 16, then 18 (step 2, the spec's 60Hz-sim/30Hz-input cadence).
    // W1 and W2 are built AND encoded -- proving they really would have
    // carried these intents -- but neither is ever passed to decodeInput,
    // standing in for two packets lost in transit. Only W3 arrives.
    const w1 = windowEndingAt(14) // ticks 0..14
    const w2 = windowEndingAt(16) // ticks 2..16
    const w3 = windowEndingAt(18) // ticks 4..18

    const buf1 = new Uint8Array(32)
    const buf2 = new Uint8Array(32)
    const buf3 = new Uint8Array(32)
    encodeInput(buf1, 2, w1) // sent, then dropped -- never decoded below
    encodeInput(buf2, 2, w2) // sent, then dropped -- never decoded below
    const bytes3 = encodeInput(buf3, 2, w3)

    const out = blankDatagram()
    decodeInput(buf3.subarray(0, bytes3), out)

    // W3's window is ticks 4..18. Every one of those ticks is recovered here,
    // including tick 14 -- the entire payload focus of the FIRST dropped
    // datagram, W1 -- and tick 6, which both W1 and W2 also carried. A
    // dropped packet cost nothing as long as the tick it carried is still
    // inside a later window.
    expect(out.intents.map((iv) => iv.tick)).toEqual([4, 6, 8, 10, 12, 14, 16, 18])
    expectIntentRecovered(out.intents[1], intentAt(6))  // carried by W1, W2 and W3
    expectIntentRecovered(out.intents[5], intentAt(14)) // W1's own newest tick

    // Ticks 0 and 2 -- W1's oldest entries -- are NOT in W3's window. They
    // were only ever carried by W1 and W2, both dropped, so they are gone:
    // redundancy has a horizon, not infinite memory.
    expect(out.intents.some((iv) => iv.tick === 0)).toBe(false)
    expect(out.intents.some((iv) => iv.tick === 2)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/input.test.ts`

Expected: FAIL. The last import in the file is the only one targeting a file
that doesn't exist yet (`@tapkart/sim` is a complete, merged package;
`../src/types` and `../src/quant` already exist from Tasks 3 and 5), so
Vitest's Vite-based resolver reports exactly one error:
`Error: Cannot find module '../src/input' imported from
'.../packages/protocol/test/input.test.ts'`, with a "Caused by: ... Does the
file exist?" line underneath. No test runs; this is a collection failure, not
an assertion failure.

- [ ] **Step 3: Implement `packages/protocol/src/input.ts`**

Create `packages/protocol/src/input.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/input.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck the package**

Run: `npx tsc --noEmit -p packages/protocol`
Expected: no diagnostics.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/input.ts packages/protocol/test/input.test.ts
git commit -m "feat(protocol): input datagram codec with an 8-tick redundant window

encodeInput/decodeInput pack playerId plus the last INPUT_REDUNDANCY (8)
intents into a fixed-format datagram: a 32-bit base tick (the newest
intent's), then 8 entries of an 8-bit delta plus quantized steer (8
bits) and accel (6 bits) and three 1-bit flags -- 235 bits, 30 bytes.

steer/accel quantization is local to this file: quant.ts's frozen §4
table covers WireSnapshot fields only, and Intent is a different
struct on a different channel.

A dropped datagram costs nothing as long as the ticks it carried are
still inside a later datagram's 8-entry window -- proven by a test
that encodes three back-to-back windows, decodes only the third, and
recovers ticks originally carried by the first two, including the
first datagram's own newest tick."
```
