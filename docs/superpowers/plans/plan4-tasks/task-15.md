### Task 15: `ClientLoop`'s three additive members, its two new kinds, and the `@tapkart/net` barrel

**Files:**
- Modify: `packages/net/src/client.ts` (contract §4.10 — **additive only**)
- Modify: `packages/net/src/index.ts` (contract §4.11)
- Modify: `packages/net/test/barrel.test.ts` (the shipped test that pins the public surface exactly)
- Test: `packages/net/test/client-race-control.test.ts` (new)

**Precondition.** This task closes the `net` package, so every module §4.11 lists must already exist. Verify before starting:

```bash
ls packages/net/src/socket.ts packages/net/src/wsframe.ts packages/net/src/websocket.ts \
   packages/net/src/websocket-browser.ts packages/net/src/webrtc.ts packages/net/src/webrtc-browser.ts \
   packages/net/src/signal.ts packages/net/src/liveness.ts packages/net/src/fanout.ts \
   packages/net/src/authz.ts packages/net/src/roomclient.ts
```

All eleven must print. If one is missing, its task has not landed and this one halts — a barrel written against a file that does not exist is a plan discovering at task 20 that task 8 was fiction.

**Interfaces:**

- **Consumes** — from `@tapkart/protocol`:

  ```ts
  export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void   // THROWS on a truncated buffer
  export function encodeCheckpoint(out: Uint8Array, state: SimState): number
  export function encodeSnapshot(out: Uint8Array, state: SimState, lastProcessedInputTick: number[]): number
  export function encodeHeader(out: Uint8Array, kind: MessageKind): number
  ```

- **Consumes** — from `packages/net/src/shadow.ts` (shipped; no import cycle, `shadow.ts` imports only `transport`, `receive` and `apply` from within the package):

  ```ts
  export const AUTHORITY_CHANGE_BYTES = 10
  export function encodeAuthorityChange(out: Uint8Array, tick: number, eventSeq: number): number
  /** Validates the header it skips, so it takes the WHOLE datagram. */
  export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number }
  ```

- **Consumes** — from `@tapkart/sim`: `MAX_KARTS`, `createState`, `cloneState`, `statesEqual`, `allocStateLike`, and from `packages/net/src/receive.ts`: `droppedDatagramsOf`.

- **Produces** — contract §4.10, three **members added to an existing class** (census §11: `net/client` (added members) = 3; the class gains no new exported free function):

  ```ts
  export class ClientLoop {
    // ... existing members unchanged ...
    beginRace(seed: number, characterIdx: number[], humanMask: number): void
    onHardResync(cb: (tick: number) => void): void
    hardResyncs(): number
  }
  ```

- **Produces** — contract §4.11, the barrel gains exactly nine `export *` lines: `'./socket'`, `'./wsframe'`, `'./websocket'`, `'./webrtc'`, `'./signal'`, `'./liveness'`, `'./fanout'`, `'./authz'`, `'./roomclient'`. **Not** `'./webrtc-browser'` and **not** `'./websocket-browser'`.

**What changes in `client.ts`, exactly — and what must not.**

`client.ts` is 1,061 lines, shipped, and covered by `client.test.ts`, `client-alloc.test.ts`, `convergence.test.ts`, `golden-run.test.ts`, `latejoin.test.ts`, `promotion.test.ts`, `reconnect.test.ts` and `malformed.test.ts`. Contract §4.10 opens with the constraint that makes those tests still mean something: *"Additive only; the constructor and the four existing members are unchanged, so Plan 3's `createSession` keeps compiling."*

**Unchanged, and no step below may touch them:**

- `constructor(ctx, playerId, t)` — its signature, its `{ ...ctx, isLeader: false }` copy, its `createState(this.ctx, 0, ZERO_CHARACTER_IDX)` placeholder, and the fact that **it no longer forces `phase = 'racing'`** (Task 15c item A). `beginRace` replaces the seed and the seat map; it does not touch the phase.
- `tick(localIntent)`, `corrections()`, `state()`, `remoteInterpolatorOf`, `correctionDeltaOf`, `RemoteInterpolator` and the three `REMOTE_*` constants.
- The `snapshot`-on-`'unreliable'` and `events`-on-`'reliable'` branches of `onDatagram`, the ping-ponged decode scratches, the ring, `throughWire`, the boolean latching, `reconcile` and its forward-only phase adoption.

**Added:**

1. Two kinds `onDatagram` today ignores — `checkpoint` on `'reliable'` and `authorityChange` on `'reliable'`.
2. `beginRace`, `onHardResync`, `hardResyncs`.

**Three implementation decisions this task makes, with reasons, because the contract fixes the behaviour and not the mechanism:**

- **A checkpoint is decoded into a scratch `SimState` and committed with `cloneState` only on success.** §4.10 says *"`decodeCheckpoint(payload, this.predicted)`"*, and §8.1 says *"a truncated `checkpoint` increments `droppedDatagramsOf` and changes nothing"*. Both can be true only with a scratch: `decodeCheckpoint` writes its destination field by field and throws part-way through a short buffer, so decoding straight into `predicted` leaves the client half-way between two timelines. `receive.ts`'s own rule says the same thing — *"decode into a scratch buffer, then commit; never commit a pointer to the buffer you are about to decode into"* — and `ShadowLoop` already keeps distinct pending buffers for exactly this.
- **`decodeAuthorityChange` needs the whole datagram, and the guard hands handlers the body**, so the raw view is held for the duration of one synchronous callback by wrapping the guard's own closure. It is never retained past the call. The alternative — re-deriving the two `u32`s at fixed offsets here — would put the `authorityChange` layout in a second file, and that layout is shipped, frozen and ten bytes.
- **`beginRace` forces this loop's own seat human after applying the mask.** `resolveInputs` routes a `!connected` kart through bot AI, so a client whose own bit were clear would predict a kart that ignores every input it produces. The constructor already does this; the server always sets the bit; this is the belt, and the test below asserts the mask governs all seven *other* seats.

---

- [ ] **Step 1: Write the failing test**

Create `packages/net/test/client-race-control.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ChannelName } from '@tapkart/protocol'
import { encodeCheckpoint, encodeHeader, encodeSnapshot } from '@tapkart/protocol'
import type { Intent, SimState } from '@tapkart/sim'
import { MAX_KARTS, allocStateLike, cloneState, createState, statesEqual } from '@tapkart/sim'
import { ClientLoop } from '../src/client'
import { droppedDatagramsOf } from '../src/receive'
import { AUTHORITY_CHANGE_BYTES, encodeAuthorityChange } from '../src/shadow'
import type { Transport } from '../src/transport'
import { makeNetContext } from './fixtures/net-fixtures'

const SEAT = 1
const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]
const SEED = 0x51ede5

interface FakeTransport extends Transport {
  deliver(channel: ChannelName, data: Uint8Array): void
  sentUnreliable(): number
}

function makeFakeTransport(): FakeTransport {
  const cbs: ((peerId: string, channel: ChannelName, data: Uint8Array) => void)[] = []
  let unreliable = 0
  return {
    send() {
      /* unused: ClientLoop broadcasts */
    },
    broadcast(channel) {
      if (channel === 'unreliable') unreliable++
    },
    onMessage(cb) {
      cbs.push(cb)
    },
    onPeerLost() {
      /* unused */
    },
    peers: () => ['authority'],
    close() {
      /* unused */
    },
    deliver(channel, data) {
      for (const cb of cbs) cb('authority', channel, data)
    },
    sentUnreliable: () => unreliable,
  }
}

function neutralIntent(tick: number): Intent {
  return { tick, steer: 0, accel: 1, brake: false, drift: false, useItem: false }
}

/** An authority-side state, distinguishable from anything the client would
 * predict on its own. */
function authorityState(tick: number): SimState {
  const state = createState(makeNetContext(true), SEED, CHARS)
  state.phase = 'racing'
  state.tick = tick
  state.nextEventSeq = 9
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = state.karts[i]
    k.isBot = i !== SEAT
    k.connected = i === SEAT
    k.position.x = 100 + i
    k.position.z = 200 + i
    k.heading = 0.25 * i
    k.lap.lap = 2
  }
  return state
}

function checkpointDatagram(state: SimState): Uint8Array {
  const buf = new Uint8Array(8192)
  const h = encodeHeader(buf, 'checkpoint')
  const n = encodeCheckpoint(buf.subarray(h), state)
  return buf.slice(0, h + n)
}

function snapshotDatagram(state: SimState): Uint8Array {
  const buf = new Uint8Array(1024)
  const h = encodeHeader(buf, 'snapshot')
  const n = encodeSnapshot(buf.subarray(h), state, new Array<number>(MAX_KARTS).fill(state.tick))
  return buf.slice(0, h + n)
}

function authorityChangeDatagram(tick: number, eventSeq: number): Uint8Array {
  const buf = new Uint8Array(AUTHORITY_CHANGE_BYTES)
  encodeAuthorityChange(buf, tick, eventSeq)
  return buf
}

function makeClient(): { t: FakeTransport; client: ClientLoop } {
  const t = makeFakeTransport()
  return { t, client: new ClientLoop(makeNetContext(false), SEAT, t) }
}

describe('ClientLoop.beginRace', () => {
  it('produces a state statesEqual to createState with the same arguments plus the mask', () => {
    const { client } = makeClient()
    const humanMask = 0b0000_0110 // seats 1 and 2

    client.beginRace(SEED, CHARS, humanMask)

    const expected = createState(makeNetContext(false), SEED, CHARS)
    for (let i = 0; i < MAX_KARTS; i++) {
      const human = ((humanMask >>> i) & 1) === 1
      expected.karts[i].isBot = !human
      expected.karts[i].connected = human
    }
    expect(statesEqual(client.state(), expected)).toBe(true)
  })

  it('leaves the phase at countdown, so the 180-tick freeze runs locally', () => {
    const { client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    expect(client.state().phase).toBe('countdown')
    expect(client.state().tick).toBe(0)
    expect(client.state().raceSeed).toBe(SEED)
  })

  it('applies the mask to every other seat, bit for bit', () => {
    const { client } = makeClient()
    client.beginRace(SEED, CHARS, 0b1000_0001) // seats 0 and 7

    expect(client.state().karts[0].isBot).toBe(false)
    expect(client.state().karts[0].connected).toBe(true)
    expect(client.state().karts[7].isBot).toBe(false)
    expect(client.state().karts[2].isBot).toBe(true)
    expect(client.state().karts[2].connected).toBe(false)
  })

  it('never leaves this loop’s own seat bot-driven, even if the mask omits it', () => {
    // resolveInputs routes a !connected kart through bot AI, so a client whose
    // own bit were clear would predict a kart that ignores every input it
    // produces - and reconciliation would never converge for that seat.
    const { client } = makeClient()
    client.beginRace(SEED, CHARS, 0b0000_0001) // seat 0 only; not this loop's
    expect(client.state().karts[SEAT].isBot).toBe(false)
    expect(client.state().karts[SEAT].connected).toBe(true)
  })

  it('clears the ring, the correction count and the hard-resync count', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    for (let i = 0; i < 30; i++) client.tick(neutralIntent(i + 1))

    // A snapshot for a tick the ring cannot reach forces a hard resync.
    t.deliver('unreliable', snapshotDatagram(authorityState(5000)))
    client.tick(neutralIntent(31))
    expect(client.hardResyncs()).toBe(1)
    expect(client.corrections()).toBeGreaterThan(0)

    client.beginRace(SEED, CHARS, 0b11)

    expect(client.hardResyncs()).toBe(0)
    expect(client.corrections()).toBe(0)
    expect(client.state().tick).toBe(0)

    // The ring is empty, so the next snapshot cannot anchor either: proof the
    // window was cleared rather than left holding a dead timeline.
    let resyncs = 0
    client.onHardResync(() => resyncs++)
    t.deliver('unreliable', snapshotDatagram(authorityState(4000)))
    client.tick(neutralIntent(1))
    expect(resyncs).toBe(1)
  })
})

describe('ClientLoop.onHardResync', () => {
  it('fires with the tick the loop rebased onto, for every listener', () => {
    const { t, client } = makeClient()
    const a: number[] = []
    const b: number[] = []
    client.onHardResync((tick) => a.push(tick))
    client.onHardResync((tick) => b.push(tick))

    client.beginRace(SEED, CHARS, 0b11)
    t.deliver('unreliable', snapshotDatagram(authorityState(4321)))
    client.tick(neutralIntent(1))

    expect(a).toEqual([4321])
    expect(b).toEqual([4321])
    expect(client.hardResyncs()).toBe(1)
    expect(client.state().tick).toBe(4321)
  })

  it('does not fire when reconciliation finds its anchor', () => {
    const { t, client } = makeClient()
    let fired = 0
    client.onHardResync(() => fired++)
    client.beginRace(SEED, CHARS, 0b11)
    for (let i = 0; i < 10; i++) client.tick(neutralIntent(i + 1))

    t.deliver('unreliable', snapshotDatagram(authorityState(8)))
    client.tick(neutralIntent(11))

    expect(fired).toBe(0)
    expect(client.hardResyncs()).toBe(0)
  })
})

describe('ClientLoop - checkpoint on the reliable channel', () => {
  it('adopts the decoded state whole, and clears the ring', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    for (let i = 0; i < 20; i++) client.tick(neutralIntent(i + 1))

    const truth = authorityState(900)
    t.deliver('reliable', checkpointDatagram(truth))

    expect(client.state().tick).toBe(900)
    expect(statesEqual(client.state(), truth)).toBe(true)

    // Everything buffered against the old timeline was worthless, and the ring
    // proves it: the very next snapshot has nothing to anchor against.
    let resyncs = 0
    client.onHardResync(() => resyncs++)
    t.deliver('unreliable', snapshotDatagram(authorityState(950)))
    client.tick(neutralIntent(901))
    expect(resyncs).toBe(1)
    expect(client.state().tick).toBe(950)
  })

  it('drops a truncated checkpoint, counts it, and changes NOTHING', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    for (let i = 0; i < 5; i++) client.tick(neutralIntent(i + 1))
    const before = allocStateLike(makeNetContext(false), client.state())
    cloneState(client.state(), before)
    const droppedBefore = droppedDatagramsOf(client)

    const full = checkpointDatagram(authorityState(900))
    t.deliver('reliable', full.subarray(0, full.length - 40))

    expect(droppedDatagramsOf(client)).toBe(droppedBefore + 1)
    expect(statesEqual(client.state(), before)).toBe(true)
  })

  it('ignores a checkpoint on the unreliable channel', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    const tick = client.state().tick

    t.deliver('unreliable', checkpointDatagram(authorityState(900)))

    expect(client.state().tick).toBe(tick)
  })
})

describe('ClientLoop - authorityChange on the reliable channel', () => {
  it('raises nextEventSeq and changes no kart field', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    for (let i = 0; i < 12; i++) client.tick(neutralIntent(i + 1))
    const before = allocStateLike(makeNetContext(false), client.state())
    cloneState(client.state(), before)

    t.deliver('reliable', authorityChangeDatagram(742, 31))

    // Spec §5: "there is no rewind" - the shadow has been ticking all along.
    expect(client.state().tick).toBe(before.tick)
    expect(client.state().phase).toBe(before.phase)
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(client.state().karts[i].position.x).toBe(before.karts[i].position.x)
      expect(client.state().karts[i].position.z).toBe(before.karts[i].position.z)
      expect(client.state().karts[i].heading).toBe(before.karts[i].heading)
      expect(client.state().karts[i].lap.lap).toBe(before.karts[i].lap.lap)
      expect(client.state().karts[i].isBot).toBe(before.karts[i].isBot)
      expect(client.state().karts[i].connected).toBe(before.karts[i].connected)
    }
    // The one field that moves: without it, the promoted authority's first
    // event is rejected as a duplicate by applyEvent's
    // `ev.eventSeq < state.nextEventSeq` guard, silently, on every client.
    expect(client.state().nextEventSeq).toBe(31)
  })

  it('never LOWERS nextEventSeq', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    t.deliver('reliable', authorityChangeDatagram(700, 40))
    t.deliver('reliable', authorityChangeDatagram(800, 12))
    expect(client.state().nextEventSeq).toBe(40)
  })

  it('drops a truncated authorityChange and counts it', () => {
    const { t, client } = makeClient()
    const droppedBefore = droppedDatagramsOf(client)
    t.deliver('reliable', authorityChangeDatagram(700, 40).subarray(0, 6))
    expect(droppedDatagramsOf(client)).toBe(droppedBefore + 1)
    expect(client.state().nextEventSeq).toBe(0)
  })

  it('ignores an authorityChange on the unreliable channel', () => {
    const { t, client } = makeClient()
    t.deliver('unreliable', authorityChangeDatagram(700, 40))
    expect(client.state().nextEventSeq).toBe(0)
  })
})

describe('ClientLoop - the four members that must not have moved', () => {
  it('still predicts, still sends input at 30 Hz, and still reports corrections', () => {
    const { t, client } = makeClient()
    client.beginRace(SEED, CHARS, 0b11)
    for (let i = 0; i < 10; i++) client.tick(neutralIntent(i + 1))

    expect(client.state().tick).toBe(10)
    expect(t.sentUnreliable()).toBe(5) // every other tick
    expect(client.corrections()).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/client-race-control.test.ts`

Expected: FAIL with

```
TypeError: client.beginRace is not a function
```

on the first test, and the same class of failure for `onHardResync` and `hardResyncs` in the others. (`ClientLoop` imports fine — the class exists; the three members do not.)

- [ ] **Step 3: Modify `packages/net/src/client.ts`**

Five edits. Anchors are quoted from the shipped file; if surrounding text has drifted, the **rule** is what binds — contract §2.10: *"Line numbers in §2 are evidence, not contract."*

**3.1 — imports.** Add `decodeCheckpoint` to the `@tapkart/protocol` value import and a new line for `decodeAuthorityChange`:

```ts
import { EPS, INPUT_REDUNDANCY, decodeCheckpoint, decodeEvents, decodeInput, decodeSnapshot, encodeHeader, encodeInput } from '@tapkart/protocol'
```

and, beside the other intra-package imports (`./transport`, `./receive`, `./clock`, `./apply`):

```ts
// No cycle: shadow.ts imports only ./transport, ./receive and ./apply from
// within this package, and nothing at all from ./client.
import { decodeAuthorityChange } from './shadow'
```

**3.2 — module-local holder, above `export class ClientLoop`.** Not exported: contract §11 counts exactly three added names for this module, and all three are class members.

```ts
/** decodeAuthorityChange RETURNS its result while DatagramGuard.decode takes a
 * `(buf, out) => void`. One holder, allocated once, bridges the two without
 * allocating per datagram. */
interface AuthorityChangeHolder { value: { tick: number; eventSeq: number } | null }

const intoAuthorityChange = (buf: Uint8Array, out: AuthorityChangeHolder): void => {
  out.value = decodeAuthorityChange(buf)
}
```

**3.3 — fields.** After

```ts
  private correctionCount = 0
  private readonly correctionDelta: CorrectionDelta = { applied: false, x: 0, y: 0, z: 0, heading: 0 }
```

add:

```ts
  /** decodeCheckpoint writes its destination field by field and THROWS part-way
   * through a truncated buffer, so a checkpoint is decoded here and committed
   * into `predicted` only once the decode returned. receive.ts's own rule:
   * "decode into a scratch buffer, then commit". */
  private readonly checkpointScratch: SimState
  private readonly authorityHolder: AuthorityChangeHolder = { value: null }
  /** The datagram currently being dispatched, header included. The guard hands
   * handlers the BODY; decodeAuthorityChange validates the header it skips and
   * therefore needs the whole datagram. Set for the duration of one synchronous
   * callback and cleared after it - never retained. */
  private rawDatagram: Uint8Array | null = null
  private hardResyncCount = 0
  private readonly hardResyncCbs: ((tick: number) => void)[] = []
```

**3.4 — constructor.** After

```ts
    this.replayScratch = allocStateLike(this.ctx, this.predicted)
```

add:

```ts
    this.checkpointScratch = allocStateLike(this.ctx, this.predicted)
```

and replace the message registration

```ts
    this.guard = createDatagramGuard(this)
    t.onMessage(this.guard.wrap((_peerId, channel, kind, payload) => {
      this.onDatagram(channel, kind, payload)
    }))
```

with

```ts
    this.guard = createDatagramGuard(this)
    const guarded = this.guard.wrap((_peerId, channel, kind, payload) => {
      this.onDatagram(channel, kind, payload)
    })
    t.onMessage((peerId, channel, data) => {
      this.rawDatagram = data
      try {
        guarded(peerId, channel, data)
      } finally {
        this.rawDatagram = null
      }
    })
```

**3.5 — `onDatagram`.** Immediately after the `events` branch closes and immediately **before** the comment that begins `// Every other kind - checkpoint, authorityChange, the lobby kinds - has no`, insert:

```ts
    if (kind === 'checkpoint' && channel === 'reliable') {
      // Full-precision truth. Through the guard, into a scratch state: a
      // truncated checkpoint is a datagram that never arrived, and decoding
      // straight into `predicted` would leave this client half-way between two
      // timelines (decodeCheckpoint throws on an itemBoxes length mismatch,
      // checkpoint.ts, and past the end of a short buffer).
      if (!this.guard.decode(decodeCheckpoint, payload, this.checkpointScratch)) return
      cloneState(this.checkpointScratch, this.predicted)
      // Everything buffered against the old timeline is worthless: the ring
      // holds checkpoints of ticks this state has just replaced, and a pending
      // snapshot describes a timeline this client no longer has.
      this.ringNewestTick = -1
      this.ringCount = 0
      this.pendingAppliedEvents.length = 0
      this.pendingSnapshot = null
      this.highestSeenSnapshotTick = this.predicted.tick
      return
    }
    if (kind === 'authorityChange' && channel === 'reliable') {
      const raw = this.rawDatagram
      if (raw === null) return
      if (!this.guard.decode(intoAuthorityChange, raw, this.authorityHolder)) return
      const msg = this.authorityHolder.value
      if (msg === null) return
      // NOT a reset and NOT a ring clear: spec §5 is explicit that "there is no
      // rewind", because the shadow has been ticking all along. The only state
      // change is the event counter, so the promoted authority's first event is
      // not rejected as a duplicate by applyEvent's
      // `ev.eventSeq < state.nextEventSeq` guard - which would be silent on
      // every client at once.
      if (msg.eventSeq > this.predicted.nextEventSeq) this.predicted.nextEventSeq = msg.eventSeq
      return
    }
```

and rewrite the comment that follows so it stops claiming these two are unhandled:

```ts
    // Every other kind - the lobby kinds, ping and pong - belongs to RoomClient,
    // which subscribes to the same transport (Transport.onMessage APPENDS,
    // contract §2.1 rule 1). A known kind this loop does not implement is simply
    // ignored.
```

**3.6 — `hardResync`.** At the end of the method, after `this.ringCount = 0`, add:

```ts
    this.hardResyncCount++
    // Fired after the rebase, so a listener reading state() sees the timeline it
    // is being told about. The consumer calls RoomClient.requestResync
    // ('divergence', tick) when this crosses HARD_RESYNC_LIMIT within
    // HARD_RESYNC_WINDOW_TICKS; this loop never sends, because it holds the RACE
    // transport and the request goes over the CONTROL transport.
    for (const cb of this.hardResyncCbs) cb(snap.tick)
```

**3.7 — the three new members**, added inside the class beside `corrections()` and `state()`:

```ts
  /**
   * The `start` message, applied. Rebuilds `predicted` as
   * createState(ctx, seed, characterIdx) and applies `humanMask` to isBot and
   * connected, replacing the constructor's seed-0 / all-zero-characterIdx
   * placeholder - which exists only because Plan 2 had no `start` message to be
   * told any of this by.
   *
   * The PHASE IS LEFT at createState's 'countdown', so the 180-tick freeze runs
   * locally: countdown is free, because everyone who calls createState with the
   * same seed and the same seat map is aligned for the first 180 ticks whatever
   * the network does.
   *
   * humanMask, exactly: bit i set means seat i is a connected human. Every clear
   * bit is a bot. If the host, the shadow and a client disagree by one bit, one
   * kart is driven by bot AI on one machine and by a player on another, and the
   * only symptom is that reconciliation never converges for that seat.
   */
  beginRace(seed: number, characterIdx: number[], humanMask: number): void {
    const fresh = createState(this.ctx, seed, characterIdx)
    cloneState(fresh, this.predicted)
    for (let i = 0; i < MAX_KARTS; i++) {
      const human = ((humanMask >>> i) & 1) === 1
      this.predicted.karts[i].isBot = !human
      this.predicted.karts[i].connected = human
    }
    // This loop's own seat is never bot-driven in its own prediction:
    // resolveInputs routes a !connected kart through bot AI, so a client whose
    // own bit were clear would predict a kart that ignores every input it
    // produces. The server always sets it; this is the belt, and it matches what
    // the constructor already does.
    this.predicted.karts[this.playerId].isBot = false
    this.predicted.karts[this.playerId].connected = true

    // Every banked tick, every pending correction and every latched button
    // belongs to a race that is over. BOTH ring cursors, and
    // highestSeenSnapshotTick too: leaving that at the old race's value makes
    // every snapshot of the new one look stale and silently discards the lot.
    this.ringNewestTick = -1
    this.ringCount = 0
    this.pendingAppliedEvents.length = 0
    this.pendingSnapshot = null
    this.highestSeenSnapshotTick = -1
    this.correctionCount = 0
    this.correctionDelta.applied = false
    this.hardResyncCount = 0
    this.latchedBrake = false
    this.latchedDrift = false
    this.latchedUseItem = false
  }

  /** Fires when reconciliation could not find `snap.tick` in the ring and had to
   * hardResync. Appends, like every other listener registration in this package. */
  onHardResync(cb: (tick: number) => void): void {
    this.hardResyncCbs.push(cb)
  }

  /** Count of hard resyncs since construction (or since the last beginRace), for
   * contract §6.4's repeated-divergence rule. */
  hardResyncs(): number {
    return this.hardResyncCount
  }
```

- [ ] **Step 4: Modify the barrel and its test**

**4.1 — `packages/net/src/index.ts`.** Append, after the nine lines already there:

```ts
// [Plan 4] The two real transports and their pure scaffolding, plus the lobby
// client. NOT './webrtc-browser' and NOT './websocket-browser': contract §0's
// barrel rule, so a headless import of @tapkart/net can never reach a file that
// names a DOM global - and `server` imports this barrel.
export * from './socket'
export * from './wsframe'
export * from './websocket'
export * from './webrtc'
export * from './signal'
export * from './liveness'
export * from './fanout'
export * from './authz'
export * from './roomclient'
```

**4.2 — `packages/net/test/barrel.test.ts`.** Four edits, all mechanical, all exact-set.

Add the namespace imports beside the existing ones:

```ts
import * as authzNs from '../src/authz'
import * as fanoutNs from '../src/fanout'
import * as livenessNs from '../src/liveness'
import * as roomclientNs from '../src/roomclient'
import * as signalNs from '../src/signal'
import * as socketNs from '../src/socket'
import * as webrtcNs from '../src/webrtc'
import * as websocketNs from '../src/websocket'
import * as wsframeNs from '../src/wsframe'
// Imported ONLY so this file can assert that not one of their names is
// reachable through the barrel. These two are the only files in `net` that name
// a DOM global.
import * as webrtcBrowserNs from '../src/webrtc-browser'
import * as websocketBrowserNs from '../src/websocket-browser'
```

Add to `SURFACE` (runtime names only — types are erased and are pinned by `TYPE_SURFACE` below):

```ts
  // [Plan 4 §4.1]
  socket: ['WS_CLOSE_BACKPRESSURE', 'WS_CLOSE_ROOM_CLOSED', 'WS_CLOSE_VERSION_MISMATCH'],
  // [Plan 4 §4.2] the three-byte envelope, and the only place it is written.
  wsframe: [
    'WS_CHANNEL_RELIABLE', 'WS_CHANNEL_UNRELIABLE', 'WS_CONTROL_PEER_GONE', 'WS_CONTROL_PEER_JOINED',
    'WS_FRAME_CONTROL', 'WS_FRAME_DATA', 'WS_HEADER_BYTES', 'WS_SLOT_BROADCAST', 'WS_SLOT_SERVER',
    'byteOfChannel', 'channelOfByte', 'decodeWsFrame', 'encodeWsControl', 'encodeWsData',
  ],
  // [Plan 4 §4.3]
  websocket: ['WS_MAX_BUFFERED_BYTES', 'WS_MAX_RELIABLE_BUFFERED_BYTES', 'makeWebSocketTransport'],
  // [Plan 4 §4.5]
  webrtc: ['DEFAULT_ICE_SERVERS', 'RTC_CHANNEL_INIT', 'RTC_CONNECT_TIMEOUT_MS', 'RTC_QUEUE_MAX', 'makeWebRtcTransport'],
  // [Plan 4 §4.4]
  signal: ['SIGNAL_MAX_BYTES', 'SIGNAL_VERSION', 'encodeSignal', 'parseSignal'],
  // [Plan 4 §4.8] peer liveness only - there is no HostWatch and no hostLost
  // (F-P4-22 puts the one host-loss detector inside ShadowLoop.tick).
  liveness: [
    'PEER_STALE_MS', 'PING_INTERVAL_MS', 'createLiveness', 'isStale', 'notePacket',
    'notePingSent', 'notePong', 'shouldSendPing',
  ],
  // [Plan 4 §4.6]
  fanout: ['PEER_ID_SEPARATOR', 'makeFanOutTransport', 'scopePeerId', 'splitPeerId'],
  // [Plan 4 §4.7]
  authz: ['peerAuthorityDropsOf', 'withPeerAuthority'],
  // [Plan 4 §4.9]
  roomclient: ['HARD_RESYNC_LIMIT', 'HARD_RESYNC_WINDOW_TICKS', 'RoomClient'],
```

Extend the three lists, and add the one that did not exist before:

```ts
/** The barrel's `export *` lines, in the order src/index.ts lists them. */
const BARREL_MODULES = [
  'clock', 'transport', 'loopback', 'apply', 'authority', 'client', 'shadow', 'local', 'receive',
  'socket', 'wsframe', 'websocket', 'webrtc', 'signal', 'liveness', 'fanout', 'authz', 'roomclient',
]

/**
 * In src/ and DELIBERATELY NOT on the barrel (contract §0, §4.11). Each is an
 * ADAPTER naming a DOM global, and `packages/server` imports this barrel: a
 * `export * from './webrtc-browser'` line would put `RTCPeerConnection` on the
 * import path of a headless Node process. Listed rather than filtered by name
 * pattern, so adding a third one is a decision somebody makes here.
 */
const UNBARRELLED_MODULES = ['webrtc-browser', 'websocket-browser']

const NAMESPACES: [string, object][] = [
  ['clock', clockNs],
  ['transport', transportNs],
  ['loopback', loopbackNs],
  ['apply', applyNs],
  ['authority', authorityNs],
  ['client', clientNs],
  ['shadow', shadowNs],
  ['local', localNs],
  ['receive', receiveNs],
  ['socket', socketNs],
  ['wsframe', wsframeNs],
  ['websocket', websocketNs],
  ['webrtc', webrtcNs],
  ['signal', signalNs],
  ['liveness', livenessNs],
  ['fanout', fanoutNs],
  ['authz', authzNs],
  ['roomclient', roomclientNs],
]
```

Replace the `it('lists every module in src/ exactly once, and no test file')` body with one that knows about the two adapters, and add the assertion that keeps them out:

```ts
  it('lists every module in src/ exactly once, and no test file', () => {
    const onDisk = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -3))
      .sort()
    expect(onDisk, 'a module was added to src/ without a decision about the barrel')
      .toEqual([...BARREL_MODULES, ...UNBARRELLED_MODULES].sort())

    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    for (const name of BARREL_MODULES) {
      const line = `export * from './${name}'`
      expect(barrel, `barrel is missing ${line}`).toContain(line)
      expect(barrel.split(line).length - 1, `${line} appears more than once`).toBe(1)
    }
    expect(barrel.match(/export \* from/g) ?? [], 'the barrel has an export line this test does not know about')
      .toHaveLength(BARREL_MODULES.length)
  })

  it('cannot reach a DOM global through the public barrel', () => {
    const surface = new Set(Object.keys(net))
    for (const [mod, ns] of [
      ['webrtc-browser', webrtcBrowserNs],
      ['websocket-browser', websocketBrowserNs],
    ] as [string, object][]) {
      const names = Object.keys(ns)
      expect(names.length, `${mod} exports nothing, so this check proves nothing`).toBeGreaterThan(0)
      for (const name of names) {
        expect(surface.has(name), `${mod}.${name} is reachable through the public barrel`).toBe(false)
      }
      expect(BARREL_MODULES).not.toContain(mod)
    }
    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    expect(barrel).not.toContain('-browser')
  })
```

Finally extend the type-only half — every interface and type alias the nine new modules export:

```ts
interface NetTypeSurface {
  TickAccumulator: TickAccumulator
  Transport: Transport
  LoopbackOptions: LoopbackOptions
  RemoteKeyframe: RemoteKeyframe
  RemoteSample: RemoteSample
  RemoteEntitySample: RemoteEntitySample
  LocalInputTransport: LocalInputTransport
  DatagramGuard: DatagramGuard
  SocketData: SocketData
  SocketReadyState: SocketReadyState
  SocketLike: SocketLike
  WsFrame: WsFrame
  WebSocketTransportOptions: WebSocketTransportOptions
  WebSocketTransport: WebSocketTransport
  RtcConnectionState: RtcConnectionState
  RtcChannelInit: RtcChannelInit
  IceCandidateInit: IceCandidateInit
  IceServerConfig: IceServerConfig
  RtcDataChannelLike: RtcDataChannelLike
  RtcConnectionLike: RtcConnectionLike
  RtcConnectionFactory: RtcConnectionFactory
  WebRtcTransportOptions: WebRtcTransportOptions
  WebRtcTransport: WebRtcTransport
  SignalMessage: SignalMessage
  SignalEnvelope: SignalEnvelope
  LivenessState: LivenessState
  FanOutPart: FanOutPart
  FanOutTransport: FanOutTransport
  PeerAuthority: PeerAuthority
  PeerAuthorityDrops: PeerAuthorityDrops
  RoomPhase: RoomPhase
  RoomClientState: RoomClientState
  RoomClientOptions: RoomClientOptions
  RoomClientUpdate: RoomClientUpdate
}
```

with the matching `import type { … } from '../src/index'` additions, the matching `TYPE_SURFACE` record entries (`Name: true` for each), and the sorted-name list in `it('pins the type-only surface at compile time')` replaced by `Object.keys(TYPE_SURFACE).sort()`'s expected value — write it out in full rather than computing it from the record, which is what makes it a pin at all:

```ts
    expect(Object.keys(TYPE_SURFACE).sort()).toEqual([
      'DatagramGuard', 'FanOutPart', 'FanOutTransport', 'IceCandidateInit', 'IceServerConfig',
      'LivenessState', 'LocalInputTransport', 'LoopbackOptions', 'PeerAuthority', 'PeerAuthorityDrops',
      'RemoteEntitySample', 'RemoteKeyframe', 'RemoteSample', 'RoomClientOptions', 'RoomClientState',
      'RoomClientUpdate', 'RoomPhase', 'RtcChannelInit', 'RtcConnectionFactory', 'RtcConnectionLike',
      'RtcConnectionState', 'RtcDataChannelLike', 'SignalEnvelope', 'SignalMessage', 'SocketData',
      'SocketLike', 'SocketReadyState', 'TickAccumulator', 'Transport', 'WebRtcTransport',
      'WebRtcTransportOptions', 'WebSocketTransport', 'WebSocketTransportOptions', 'WsFrame',
    ])
```

**If a name in any list above does not exist**, do not delete it from the list and do not invent it: the module that owns it has shipped something other than what contract §4 and §11's census say, and that is a contract violation to raise, not to paper over. The census is the check — `net`'s new subtotal is **77** exported names across the nine modules plus three added `ClientLoop` members.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/net`

Expected: PASS, every file in the package — the new `client-race-control.test.ts` (15 tests), the amended `barrel.test.ts`, and every shipped `client.ts` test unchanged. `convergence.test.ts` and `golden-run.test.ts` passing is the evidence that §4.10's "additive only" held: they exercise the constructor, `tick`, `corrections` and `state` against a recorded fixture, and a behavioural change in any of them shows up there rather than in review.

Then: `npx tsc --noEmit -p packages/net/tsconfig.json` — expected: no output. The type-only surface is a compile-time pin and vitest cannot check it.

- [ ] **Step 6: Commit**

```bash
git add packages/net/src/client.ts packages/net/src/index.ts packages/net/test/barrel.test.ts packages/net/test/client-race-control.test.ts && git commit -m "feat(net): ClientLoop learns checkpoint, authorityChange and beginRace; barrel closed

Additive only: the constructor and the four existing members are untouched, so
Plan 3's createSession keeps compiling. A checkpoint is decoded into a scratch
state and committed whole; an authorityChange raises nextEventSeq and rewinds
nothing. The barrel gains the nine Plan 4 modules and refuses the two -browser
adapters, with the exact-set test to prove it."
```
