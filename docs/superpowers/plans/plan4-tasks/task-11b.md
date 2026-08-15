### Task 11b: `packages/net/src/fanout.ts` — two transports, one `Transport`

> Split out of Task 11: §4.5's WebRTC state machine and its in-memory connection
> fixture are a task on their own. **This task is independent of Task 11** — it
> consumes `Transport` and nothing from `webrtc.ts` — and can run before it,
> after it, or beside it.

**Files:**
- Create: `packages/net/src/fanout.ts`
- Create: `packages/net/test/fanout.test.ts`
- Modify: `packages/net/src/index.ts` (one `export *` line)
- Modify: `packages/net/test/barrel.test.ts` (the pinned public surface)
- Test: `packages/net/test/fanout.test.ts`

**This module is PURE** (contract §0a): a `Transport` composed of `Transport`s,
with no socket, no clock and no I/O of any kind. It has **no adapter half at
all** — the real transports it composes are Task 9's and Task 11's, and it never
learns which is which.

**Why it exists.** Spec §5: *"Every client sends its input to **both** the host
and the server shadow."* Plan 2 §5 resolved that as "a client's transport holds
two peers", but **no type in the repository combines two transports into one.**
This is it. On a guest it holds the WebRTC link to the host and the WebSocket to
the room; on a host it holds one WebRTC link per guest plus the server socket.

---

**Interfaces:**

**Consumes** — from `@tapkart/protocol` (bare specifier, type-only):

```ts
export type ChannelName = 'unreliable' | 'reliable'
```

**Consumes** — from `./transport` (contract §2.1, quoted exactly):

```ts
export interface Transport {
  send(channel: ChannelName, peerId: string, data: Uint8Array): void
  broadcast(channel: ChannelName, data: Uint8Array): void
  onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
  onPeerLost(cb: (peerId: string) => void): void
  peers(): string[]
  close(): void
}
```

The six unstated behaviours (§2.1) bind this implementation **and** are what it
relies on from its parts: `onMessage`/`onPeerLost` **append**, never replace —
which is why registering one listener per part at `addPart` cannot disturb a
listener the part already had; `send` to an unknown peer is a **no-op, not a
throw**; `close()` is idempotent and afterwards `peers()` is `[]` with nothing
delivered either way.

**Produces** — `packages/net/src/fanout.ts`, exactly six exported names
(contract §4.6, §11's census row `net/fanout | 6`):

```ts
export const PEER_ID_SEPARATOR = '/'

export interface FanOutPart { id: string; transport: Transport }

export interface FanOutTransport extends Transport {
  /** Late-joining guests appear on the host mid-lobby, so parts are dynamic. */
  addPart(part: FanOutPart): void
  removePart(id: string): void
  partIds(): string[]
}

export function scopePeerId(partId: string, peerId: string): string
export function splitPeerId(scoped: string): { partId: string; peerId: string } | null
export function makeFanOutTransport(parts?: FanOutPart[]): FanOutTransport
```

**Behaviour fixed by contract §4.6:**

- Peer ids are namespaced `partId + '/' + peerId` so two parts cannot collide.
  **Neither a part id nor an inner peer id may contain `'/'`, asserted on add**
  (P4 Q41). `AuthorityLoop` uses `peerId` only as a `Map` key
  (`authority.ts:86`), so any opaque string works — but a room log with
  `rtc/host` in it is easier to read than a UUID, and readable room logs are
  worth the assertion.
- `broadcast` calls `broadcast` on **every** part — one call, N recipients, which
  is exactly the shape `ClientLoop.tick` already uses (`client.ts:498`).
- `send` routes by the part prefix; an unparseable or unknown scoped id is a
  **no-op**.
- `onPeerLost` from a part is re-emitted **scoped**.
- **`removePart` emits `onPeerLost` for each of that part's peers FIRST**, so an
  authority learns about the karts rather than silently keeping them frozen.
- `close()` closes every part.

**Two decisions this task makes, which §4.6 leaves open:**

1. **`removePart` does not `close()` the part.** The caller owns that transport's
   lifetime — a promotion swaps which transport is authoritative while the same
   socket keeps carrying traffic — so closing here would tear down a live link
   the room still needs.
2. **`addPart` throws on a duplicate id**, alongside the two throws §4.6 names.
   Two parts under one id makes `send` route to whichever the map happens to
   hold and `removePart` orphan the other; that is a caller bug, at wiring time,
   in this process's own data — the same class as `lobbyPathFor`'s throw, and the
   opposite of an untrusted-input path.

---

- [ ] **Step 1: Write the failing test**

Create `packages/net/test/fanout.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from '../src/transport'
import {
  PEER_ID_SEPARATOR,
  makeFanOutTransport,
  scopePeerId,
  splitPeerId,
} from '../src/fanout'

interface SpyTransport extends Transport {
  sent: Array<[ChannelName, string, number]>
  broadcasts: Array<[ChannelName, number]>
  closes: number
  deliver(peerId: string, channel: ChannelName, data: Uint8Array): void
  losePeer(peerId: string): void
  setPeers(ids: string[]): void
}

function makeSpy(peerIds: string[]): SpyTransport {
  let ids = [...peerIds]
  const messageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const peerLostCbs: Array<(peerId: string) => void> = []
  const spy: SpyTransport = {
    sent: [],
    broadcasts: [],
    closes: 0,
    send(channel, peerId, data): void {
      spy.sent.push([channel, peerId, data[0]])
    },
    broadcast(channel, data): void {
      spy.broadcasts.push([channel, data[0]])
    },
    onMessage(cb): void {
      messageCbs.push(cb)
    },
    onPeerLost(cb): void {
      peerLostCbs.push(cb)
    },
    peers: () => [...ids],
    close(): void {
      spy.closes++
    },
    deliver(peerId, channel, data): void {
      for (const cb of [...messageCbs]) cb(peerId, channel, data)
    },
    losePeer(peerId): void {
      ids = ids.filter((i) => i !== peerId)
      for (const cb of [...peerLostCbs]) cb(peerId)
    },
    setPeers(next): void {
      ids = [...next]
    },
  }
  return spy
}

const D = (n: number): Uint8Array => new Uint8Array([n, 2, 0])

describe('net/fanout - peer id scoping', () => {
  it('round-trips a scoped id and refuses to guess at a broken one', () => {
    expect(PEER_ID_SEPARATOR).toBe('/')
    expect(scopePeerId('rtc', 'host')).toBe('rtc/host')
    expect(splitPeerId('rtc/host')).toEqual({ partId: 'rtc', peerId: 'host' })
    // Split at the FIRST separator, so an inner id with a slash still
    // round-trips rather than being silently reassigned to another part.
    expect(splitPeerId(scopePeerId('ws', 'p2/x'))).toEqual({ partId: 'ws', peerId: 'p2/x' })

    for (const bad of ['', 'nosep', '/leading', 'trailing/']) {
      expect(splitPeerId(bad), bad).toBeNull()
    }
  })

  it('throws on a part id that would make a scoped id ambiguous', () => {
    const t = makeFanOutTransport()
    expect(() => t.addPart({ id: 'a/b', transport: makeSpy([]) })).toThrow(/contain no/)
    expect(() => t.addPart({ id: '', transport: makeSpy([]) })).toThrow()
    // ...and on an inner peer id carrying the separator, checked at add.
    expect(() => t.addPart({ id: 'rtc', transport: makeSpy(['ho/st']) })).toThrow(/contains/)

    t.addPart({ id: 'ws', transport: makeSpy([]) })
    expect(() => t.addPart({ id: 'ws', transport: makeSpy([]) })).toThrow(/duplicate/)
    expect(t.partIds()).toEqual(['ws'])
  })
})

describe('net/fanout - one call, N recipients', () => {
  it('broadcasts to EVERY part', () => {
    // Spec §5: every client sends its input to both the host and the server
    // shadow. A fan-out that reached only the first part would look completely
    // healthy right up until the host dropped.
    const rtc = makeSpy(['host'])
    const ws = makeSpy(['p0'])
    const t = makeFanOutTransport([
      { id: 'rtc', transport: rtc },
      { id: 'ws', transport: ws },
    ])

    t.broadcast('unreliable', D(0x10))

    expect(rtc.broadcasts).toEqual([['unreliable', 0x10]])
    expect(ws.broadcasts).toEqual([['unreliable', 0x10]])
  })

  it('routes send() by the part prefix and no-ops on anything it cannot place', () => {
    const rtc = makeSpy(['host'])
    const ws = makeSpy(['p0'])
    const t = makeFanOutTransport([
      { id: 'rtc', transport: rtc },
      { id: 'ws', transport: ws },
    ])

    t.send('reliable', 'ws/p0', D(0x12))
    t.send('reliable', 'rtc/host', D(0x11))
    t.send('reliable', 'gone/p0', D(0x13)) // unknown part
    t.send('reliable', 'unscoped', D(0x13)) // unparseable

    expect(ws.sent).toEqual([['reliable', 'p0', 0x12]])
    expect(rtc.sent).toEqual([['reliable', 'host', 0x11]])
  })

  it('reports every part\'s peers, scoped, and re-emits inbound datagrams scoped', () => {
    const rtc = makeSpy(['host'])
    const ws = makeSpy(['p0', 'p3'])
    const t = makeFanOutTransport([
      { id: 'rtc', transport: rtc },
      { id: 'ws', transport: ws },
    ])
    const got: Array<[string, ChannelName, number]> = []
    t.onMessage((peerId, channel, data) => got.push([peerId, channel, data[0]]))

    expect(t.peers()).toEqual(['rtc/host', 'ws/p0', 'ws/p3'])

    rtc.deliver('host', 'unreliable', D(0x11))
    ws.deliver('p3', 'reliable', D(0x12))

    expect(got).toEqual([
      ['rtc/host', 'unreliable', 0x11],
      ['ws/p3', 'reliable', 0x12],
    ])
  })

  it('appends message listeners rather than replacing them', () => {
    const ws = makeSpy(['p0'])
    const t = makeFanOutTransport([{ id: 'ws', transport: ws }])
    const seen: string[] = []
    t.onMessage(() => seen.push('first'))
    t.onMessage(() => seen.push('second'))

    ws.deliver('p0', 'reliable', D(0x03))

    expect(seen).toEqual(['first', 'second'])
  })

  it('takes a part added later, which is how a late-joining guest arrives', () => {
    const t = makeFanOutTransport()
    const got: string[] = []
    t.onMessage((peerId) => got.push(peerId))

    const late = makeSpy(['guest2'])
    t.addPart({ id: 'rtc2', transport: late })
    late.deliver('guest2', 'unreliable', D(0x10))

    expect(t.partIds()).toEqual(['rtc2'])
    expect(got).toEqual(['rtc2/guest2'])
  })
})

describe('net/fanout - losing peers and parts', () => {
  it('re-emits a part\'s own peer loss, scoped', () => {
    const rtc = makeSpy(['host'])
    const t = makeFanOutTransport([{ id: 'rtc', transport: rtc }])
    const lost: string[] = []
    t.onPeerLost((p) => lost.push(p))

    rtc.losePeer('host')

    expect(lost).toEqual(['rtc/host'])
  })

  it('emits onPeerLost for each of a removed part\'s peers BEFORE dropping it', () => {
    const rtc = makeSpy(['guest1', 'guest2'])
    const t = makeFanOutTransport([{ id: 'rtc', transport: rtc }])
    const observed: Array<[string, string[]]> = []
    // The ordering is the assertion: at the moment each loss fires, the part
    // must still be present. A remove-then-notify implementation would report
    // an empty peer list here and the karts would freeze rather than go to bots.
    t.onPeerLost((p) => observed.push([p, t.partIds()]))

    t.removePart('rtc')

    expect(observed).toEqual([
      ['rtc/guest1', ['rtc']],
      ['rtc/guest2', ['rtc']],
    ])
    expect(t.partIds()).toEqual([])
    expect(t.peers()).toEqual([])
    // Removing a part is not closing it - the caller owns that transport's
    // lifetime, and a promoted authority reuses the same socket.
    expect(rtc.closes).toBe(0)
    // And it is idempotent.
    t.removePart('rtc')
    expect(observed).toHaveLength(2)
  })

  it('closes every part, once, and goes quiet in both directions', () => {
    const rtc = makeSpy(['host'])
    const ws = makeSpy(['p0'])
    const t = makeFanOutTransport([
      { id: 'rtc', transport: rtc },
      { id: 'ws', transport: ws },
    ])
    const got: string[] = []
    const lost: string[] = []
    t.onMessage((p) => got.push(p))
    t.onPeerLost((p) => lost.push(p))

    t.close()
    t.close()

    expect(rtc.closes).toBe(1)
    expect(ws.closes).toBe(1)
    expect(t.peers()).toEqual([])

    t.broadcast('reliable', D(0x12))
    t.send('reliable', 'ws/p0', D(0x12))
    rtc.deliver('host', 'unreliable', D(0x11))
    rtc.losePeer('host')

    expect(rtc.broadcasts).toEqual([])
    expect(ws.sent).toEqual([])
    expect(got).toEqual([])
    expect(lost).toEqual([])
  })
})
```

Two assertions carry this file, and both are shaped to fail against the
implementation that "obviously works":

- **The `removePart` test captures `t.partIds()` INSIDE the `onPeerLost`
  callback.** Contract §4.6 says the losses fire *before* the part is dropped,
  and the only way to observe an ordering is from inside the callback: a test
  that merely counted two losses and then checked `partIds()` was empty passes
  identically against a remove-then-notify implementation — the one that leaves
  eight karts frozen on the track because the authority never heard.
- **The close test drives the fan-out from BOTH sides afterwards.** `closes ===
  1` alone would pass against an implementation that closed its parts and then
  went on delivering; rule 5 says nothing is delivered in either direction after
  `close()`, so the test sends, broadcasts, delivers inbound and loses a peer,
  and asserts all four produced nothing.

The `SpyTransport` is local to this file rather than a shared fixture: it is
eleven lines of recording, it is the only place that needs a `Transport` whose
peers can be set from a test, and §9.2's shared conformance harness — which is a
different task's — exercises the real implementations instead.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/fanout.test.ts`

Expected: FAIL, before any assertion runs, with

```
Error: Cannot find module '../src/fanout' imported from '<repo>/packages/net/test/fanout.test.ts'
Caused by: Error: Failed to load url ../src/fanout (resolved id: ../src/fanout) ... Does the file exist?
 Test Files  1 failed (1)
```

- [ ] **Step 3: Write the implementation**

Create `packages/net/src/fanout.ts`:

```ts
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from './transport'

/**
 * PURE (contract §0a). Spec §5: "Every client sends its input to BOTH the host
 * and the server shadow." Plan 2 §5 resolved that as "a client's transport holds
 * two peers", but no type in the repository combined two transports into one.
 * This is it - and it never learns which of its parts is WebRTC and which is a
 * WebSocket, because nothing above the transport layer knows either.
 */
export const PEER_ID_SEPARATOR = '/'

export interface FanOutPart {
  id: string
  transport: Transport
}

export interface FanOutTransport extends Transport {
  /** Late-joining guests appear on the host mid-lobby, so parts are dynamic. */
  addPart(part: FanOutPart): void
  removePart(id: string): void
  partIds(): string[]
}

/**
 * Peer ids are namespaced `partId + '/' + peerId` so two parts cannot collide.
 * AuthorityLoop uses peerId only as a Map key, so any opaque string works - but
 * a room log with `rtc/host` in it is easier to read than a UUID, and readable
 * room logs are worth the assertion in addPart.
 */
export function scopePeerId(partId: string, peerId: string): string {
  return partId + PEER_ID_SEPARATOR + peerId
}

export function splitPeerId(scoped: string): { partId: string; peerId: string } | null {
  const at = scoped.indexOf(PEER_ID_SEPARATOR)
  // Split at the FIRST separator: a part id may not contain one (asserted on
  // add), so this is exact even if an inner peer id somehow does.
  if (at <= 0 || at === scoped.length - 1) return null
  return { partId: scoped.slice(0, at), peerId: scoped.slice(at + 1) }
}

export function makeFanOutTransport(parts?: FanOutPart[]): FanOutTransport {
  const order: string[] = []
  const byId = new Map<string, Transport>()
  const messageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const peerLostCbs: Array<(peerId: string) => void> = []
  let closed = false

  function emitPeerLost(scoped: string): void {
    for (const cb of [...peerLostCbs]) cb(scoped)
  }

  const self: FanOutTransport = {
    addPart(part): void {
      // These three throws are on THIS PROCESS'S OWN wiring data, at
      // composition time - the opposite of an untrusted-input path, and the
      // same class as lobbyPathFor's throw. A silently accepted ambiguous id
      // would misroute inputs for a whole race.
      if (part.id.length === 0 || part.id.includes(PEER_ID_SEPARATOR)) {
        throw new Error(`addPart: part id '${part.id}' must be non-empty and contain no '${PEER_ID_SEPARATOR}'`)
      }
      if (byId.has(part.id)) throw new Error(`addPart: duplicate part id '${part.id}'`)
      for (const peerId of part.transport.peers()) {
        if (peerId.includes(PEER_ID_SEPARATOR)) {
          throw new Error(`addPart: peer id '${peerId}' in part '${part.id}' contains '${PEER_ID_SEPARATOR}'`)
        }
      }
      order.push(part.id)
      byId.set(part.id, part.transport)
      // One listener per part, registered once at add. Transport.onMessage
      // appends, so this never disturbs a listener the part already had.
      part.transport.onMessage((peerId, channel, data) => {
        if (closed) return
        const scoped = scopePeerId(part.id, peerId)
        for (const cb of [...messageCbs]) cb(scoped, channel, data)
      })
      part.transport.onPeerLost((peerId) => {
        if (closed) return
        emitPeerLost(scopePeerId(part.id, peerId))
      })
    },
    removePart(id): void {
      const t = byId.get(id)
      if (t === undefined) return
      // Peer loss FIRST, then the part: an authority that never hears about
      // these peers keeps their karts frozen on the track instead of handing
      // them to a bot.
      for (const peerId of t.peers()) emitPeerLost(scopePeerId(id, peerId))
      byId.delete(id)
      const at = order.indexOf(id)
      if (at >= 0) order.splice(at, 1)
      // NOT closed: the caller owns that transport's lifetime, and a promoted
      // authority reuses the same socket.
    },
    partIds(): string[] {
      return [...order]
    },
    send(channel, peerId, data): void {
      if (closed) return
      const split = splitPeerId(peerId)
      // An unparseable or unknown scoped id is a no-op, not a throw
      // (Transport rule 4).
      if (split === null) return
      const t = byId.get(split.partId)
      if (t === undefined) return
      t.send(channel, split.peerId, data)
    },
    broadcast(channel, data): void {
      if (closed) return
      // ONE call, N recipients, across every part - exactly the shape
      // ClientLoop.tick already uses.
      for (const id of order) byId.get(id)?.broadcast(channel, data)
    },
    onMessage(cb): void {
      messageCbs.push(cb)
    },
    onPeerLost(cb): void {
      peerLostCbs.push(cb)
    },
    peers(): string[] {
      if (closed) return []
      const out: string[] = []
      for (const id of order) {
        const t = byId.get(id)
        if (t === undefined) continue
        for (const peerId of t.peers()) out.push(scopePeerId(id, peerId))
      }
      return out
    },
    close(): void {
      if (closed) return
      closed = true
      for (const id of order) byId.get(id)?.close()
    },
  }

  if (parts !== undefined) {
    for (const p of parts) self.addPart(p)
  }
  return self
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/fanout.test.ts`

Expected: `Test Files  1 passed (1)` / `Tests  10 passed (10)`.

- [ ] **Step 5: Add the module to the barrel, and to the barrel test that pins it**

Skipping this turns `packages/net/test/barrel.test.ts` red with *"a module was
added to src/ without a line in the barrel"*. Sibling tasks edit the same lists —
**insert, never rewrite.**

**Task 15 closes this barrel** (contract §4.11) and its list includes this module.
Wiring it here anyway is what keeps `npm test` green *between* tasks: the shipped
barrel test fails the moment a file exists in `src/` with no `export *` line, so
deferring every line to Task 15 leaves the suite red for the whole middle of the
plan. Task 15 then finds this line already present — and its own assertion that
each `export *` line appears **exactly once** is what catches a double-add, so
never add it twice.


In `packages/net/src/index.ts`, append:

```ts
export * from './fanout'
```

In `packages/net/test/barrel.test.ts`:

```ts
// 1. beside the other namespace imports:
import * as fanoutNs from '../src/fanout'

// 2. inside `import type { ... } from '../src/index'`:
  // fanout [Plan 4 Task 11b]
  FanOutPart,
  FanOutTransport,

// 3. in SURFACE:
  // [Plan 4 Task 11b] two transports, one Transport.
  fanout: ['PEER_ID_SEPARATOR', 'makeFanOutTransport', 'scopePeerId', 'splitPeerId'],

// 4. in BARREL_MODULES, in the order index.ts lists them:
  'fanout'

// 5. in NAMESPACES:
  ['fanout', fanoutNs],

// 6. in `interface NetTypeSurface` / `const TYPE_SURFACE`:
  FanOutPart: FanOutPart            /  FanOutPart: true,
  FanOutTransport: FanOutTransport  /  FanOutTransport: true,

// 7. in the sorted literal inside "pins the type-only surface at compile time",
//    in sorted position:
  'FanOutPart', 'FanOutTransport',
```

- [ ] **Step 6: Verify the package, not just this file**

```bash
npx vitest run packages/net/test/fanout.test.ts packages/net/test/barrel.test.ts
npx tsc --noEmit -p packages/net/tsconfig.json
npx vitest run
```

- [ ] **Step 7: Commit**

```bash
git add packages/net/src/fanout.ts packages/net/test/fanout.test.ts \
        packages/net/src/index.ts packages/net/test/barrel.test.ts && \
git commit -m "feat(net): add FanOutTransport, the one type that holds two transports"
```
