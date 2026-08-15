### Task 10: `packages/net/src/signal.ts` — WebRTC signalling, JSON over text frames

**Files:**
- Create: `packages/net/src/signal.ts`
- Create: `packages/net/test/signal.test.ts`
- Modify: `packages/net/src/index.ts` (one `export *` line)
- Modify: `packages/net/test/barrel.test.ts` (the pinned public surface)
- Test: `packages/net/test/signal.test.ts`

**This module is PURE** (contract §0a): two functions of a string, no socket, no
clock, no `RTCPeerConnection`. There is no adapter half. `parseSignal` is
**total** — it returns `null` and never throws — because the server calls it on
every text frame from every socket, which makes it **the single most
attacker-reachable function in the project**.

---

**Interfaces:**

**Consumes** — from `./webrtc`, **type-only** (Task 11 defines it; contract §4.5):

```ts
export interface IceCandidateInit {
  candidate: string; sdpMid: string | null; sdpMLineIndex: number | null
}
```

**Read this before you start.** `signal.ts` type-imports `IceCandidateInit` from
`./webrtc`, and `webrtc.ts` type-imports `SignalMessage` from `./signal`. That
cycle is deliberate and it is **type-only in both directions**, so it is erased
entirely at runtime (`verbatimModuleSyntax` + `isolatedModules`; esbuild removes
`import type` statements outright, and vitest never sees an edge). The
consequence for whoever runs this task:

- **vitest is green with only one of the two files present** — the failing test
  in Step 2 fails on `../src/signal`, not on `./webrtc`.
- **`npx tsc --noEmit -p packages/net/tsconfig.json` reports one `TS2307:
  Cannot find module './webrtc'` until Task 11 lands.** That is expected, it is
  the only error, and it closes when `packages/net/src/webrtc.ts` exists.
  **Do not stub `webrtc.ts`** and do not move `IceCandidateInit` here — contract
  §4.5 owns that name, and a second definition would make the barrel's
  `export *` ambiguous, which ESM resolves by *silently dropping the name*.
- Run Tasks 10 and 11 back to back, and treat Step 6's typecheck as the gate for
  the pair. If Task 11 has already landed, `tsc` is clean here immediately.

**Produces** — `packages/net/src/signal.ts`, exactly six exported names
(contract §4.4, §11's census row `net/signal | 6`):

```ts
export const SIGNAL_VERSION = 1
export const SIGNAL_MAX_BYTES = 16384   // an SDP with many candidates, with room

export type SignalMessage =
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; c: IceCandidateInit }
  | { t: 'iceDone' }
  | { t: 'giveUp'; reason: string }

/** `from`/`to` are peer SLOTS (§4.2), so signalling and framing share one address
 *  space and the server needs no second routing table. */
export interface SignalEnvelope { v: number; from: number; to: number; msg: SignalMessage }

export function encodeSignal(env: SignalEnvelope): string
export function parseSignal(text: string): SignalEnvelope | null
```

**Why JSON over text frames and not a `WIRE_TAG` binary message** (P4 Q12,
stated so nobody "fixes" it): SDP is already a multi-kilobyte UTF-8 blob and
bit-packing it buys nothing; `MessageKind` has no offer/answer/candidate members
and adding three would put pre-connection setup into the same union as race
traffic; and a signalling exchange a human can read in a devtools frame inspector
is worth real debugging hours on the one part of this system that fails in the
field and not in CI. A WebSocket frame is natively text **or** binary and
`SocketData` preserves that (§4.1), so the split costs no discriminator byte.

**The rule this module must not break:** `parseSignal` builds its result **field
by field onto a fresh object literal**; it never spreads the parsed JSON, so
`__proto__` and `constructor` keys in a hostile payload reach nothing.

**One decision this task makes, which §4.4 leaves open:** an envelope carrying
**any key outside its schema is rejected**, at all three levels (envelope,
message, candidate). §8.1 requires `__proto__`/`constructor` keys to return
`null`, and "reject unknown keys" is the general rule that makes those two a
special case rather than a hardcoded blocklist that the next hostile key walks
around. It costs nothing in forward compatibility because the envelope is
versioned: a field added later arrives with a new `SIGNAL_VERSION`.

---

- [ ] **Step 1: Write the failing test**

Create `packages/net/test/signal.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { SignalEnvelope, SignalMessage } from '../src/signal'
import { SIGNAL_MAX_BYTES, SIGNAL_VERSION, encodeSignal, parseSignal } from '../src/signal'

const CANDIDATE = {
  candidate: 'candidate:1 1 udp 2113937151 192.0.2.7 50000 typ host',
  sdpMid: '0',
  sdpMLineIndex: 0,
}

const MESSAGES: SignalMessage[] = [
  { t: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 192.0.2.1\r\n' },
  { t: 'answer', sdp: 'v=0\r\no=- 2 1 IN IP4 192.0.2.2\r\n' },
  { t: 'ice', c: CANDIDATE },
  { t: 'ice', c: { candidate: 'a=end-of-candidates', sdpMid: null, sdpMLineIndex: null } },
  { t: 'iceDone' },
  { t: 'giveUp', reason: 'timeout' },
]

/** The canonical good envelope, re-parsed after every hostile input below. */
const GOOD: SignalEnvelope = { v: SIGNAL_VERSION, from: 3, to: 1, msg: { t: 'iceDone' } }

describe('net/signal - the envelope round-trips', () => {
  it('carries every message kind through encode and back', () => {
    for (const msg of MESSAGES) {
      const env: SignalEnvelope = { v: SIGNAL_VERSION, from: 1, to: 254, msg }
      const parsed = parseSignal(encodeSignal(env))
      expect(parsed, JSON.stringify(msg)).toEqual(env)
    }
  })

  it('keeps from/to in the SLOT address space, so signalling and framing share one', () => {
    for (const slot of [0, 1, 127, 254, 255]) {
      const env: SignalEnvelope = { v: SIGNAL_VERSION, from: slot, to: slot, msg: { t: 'iceDone' } }
      expect(parseSignal(encodeSignal(env))).toEqual(env)
    }
  })
})

describe('net/signal - parseSignal is total', () => {
  const hostile: Array<[string, string]> = [
    ['empty string', ''],
    ['whitespace', '   '],
    ['truncated JSON', '{"v":1,"from":1,"to":2,"msg":{"t":"offe'],
    ['JSON array', '[1,2,3]'],
    ['JSON string', '"hello"'],
    ['JSON number', '42'],
    ['JSON null', 'null'],
    ['no version', '{"from":1,"to":2,"msg":{"t":"iceDone"}}'],
    ['wrong version', '{"v":2,"from":1,"to":2,"msg":{"t":"iceDone"}}'],
    ['version as string', '{"v":"1","from":1,"to":2,"msg":{"t":"iceDone"}}'],
    ['from missing', '{"v":1,"to":2,"msg":{"t":"iceDone"}}'],
    ['from out of slot range', '{"v":1,"from":256,"to":2,"msg":{"t":"iceDone"}}'],
    ['from negative', '{"v":1,"from":-1,"to":2,"msg":{"t":"iceDone"}}'],
    ['from fractional', '{"v":1,"from":1.5,"to":2,"msg":{"t":"iceDone"}}'],
    ['to as string', '{"v":1,"from":1,"to":"2","msg":{"t":"iceDone"}}'],
    ['msg missing', '{"v":1,"from":1,"to":2}'],
    ['msg is an array', '{"v":1,"from":1,"to":2,"msg":[]}'],
    ['unknown t', '{"v":1,"from":1,"to":2,"msg":{"t":"hangUp"}}'],
    ['t missing', '{"v":1,"from":1,"to":2,"msg":{"sdp":"x"}}'],
    ['sdp is a number', '{"v":1,"from":1,"to":2,"msg":{"t":"offer","sdp":5}}'],
    ['sdp missing', '{"v":1,"from":1,"to":2,"msg":{"t":"answer"}}'],
    ['ice c missing', '{"v":1,"from":1,"to":2,"msg":{"t":"ice"}}'],
    ['ice candidate not a string', '{"v":1,"from":1,"to":2,"msg":{"t":"ice","c":{"candidate":7,"sdpMid":null,"sdpMLineIndex":null}}}'],
    ['ice sdpMid a number', '{"v":1,"from":1,"to":2,"msg":{"t":"ice","c":{"candidate":"x","sdpMid":3,"sdpMLineIndex":null}}}'],
    ['ice sdpMLineIndex a string', '{"v":1,"from":1,"to":2,"msg":{"t":"ice","c":{"candidate":"x","sdpMid":null,"sdpMLineIndex":"0"}}}'],
    ['giveUp reason missing', '{"v":1,"from":1,"to":2,"msg":{"t":"giveUp"}}'],
    ['__proto__ at the envelope', '{"v":1,"from":1,"to":2,"msg":{"t":"iceDone"},"__proto__":{"polluted":true}}'],
    ['constructor at the envelope', '{"v":1,"from":1,"to":2,"msg":{"t":"iceDone"},"constructor":{"prototype":{"x":1}}}'],
    ['a megabyte of sdp', `{"v":1,"from":1,"to":2,"msg":{"t":"offer","sdp":"${'a'.repeat(1024 * 1024)}"}}`],
    ['a megabyte of nothing', 'a'.repeat(1024 * 1024)],
  ]

  it('returns null - never throws - on every hostile input, and still parses the next good one', () => {
    // The single most attacker-reachable function in the project: the server
    // calls it on every text frame from every socket. A validator that rejected
    // EVERYTHING would satisfy "never throws" and break every connection, so
    // each row re-parses the good envelope immediately afterwards.
    for (const [label, text] of hostile) {
      let result: unknown = 'threw'
      expect(() => {
        result = parseSignal(text)
      }, label).not.toThrow()
      expect(result, label).toBeNull()
      expect(parseSignal(encodeSignal(GOOD)), `good envelope after: ${label}`).toEqual(GOOD)
    }
    expect(hostile.length).toBeGreaterThanOrEqual(20)
  })

  it('rejects anything past SIGNAL_MAX_BYTES without parsing it', () => {
    const sdp = 'a'.repeat(SIGNAL_MAX_BYTES)
    expect(parseSignal(`{"v":1,"from":1,"to":2,"msg":{"t":"offer","sdp":"${sdp}"}}`)).toBeNull()
    // And an SDP with many candidates - the case the cap is sized for - still
    // goes through.
    const realistic = 'v=0\r\n' + 'a=candidate:1 1 udp 2113937151 192.0.2.7 50000 typ host\r\n'.repeat(60)
    const env: SignalEnvelope = { v: SIGNAL_VERSION, from: 1, to: 2, msg: { t: 'offer', sdp: realistic } }
    expect(encodeSignal(env).length).toBeLessThan(SIGNAL_MAX_BYTES)
    expect(parseSignal(encodeSignal(env))).toEqual(env)
  })

  it('builds a fresh object literal, so no key of a hostile payload survives', () => {
    // An unknown key anywhere is a reject, at all three levels.
    expect(parseSignal('{"v":1,"from":1,"to":2,"admin":true,"msg":{"t":"iceDone"}}')).toBeNull()
    expect(parseSignal('{"v":1,"from":1,"to":2,"msg":{"t":"iceDone","extra":1}}')).toBeNull()
    expect(
      parseSignal(
        '{"v":1,"from":1,"to":2,"msg":{"t":"ice","c":{"candidate":"x","sdpMid":null,"sdpMLineIndex":null,"evil":1}}}',
      ),
    ).toBeNull()

    const env = parseSignal(
      '{"v":1,"from":1,"to":2,"msg":{"t":"ice","c":{"candidate":"x","sdpMid":null,"sdpMLineIndex":null}}}',
    )
    expect(env).not.toBeNull()
    if (env === null) return

    expect(Object.getPrototypeOf(env)).toBe(Object.prototype)
    expect(Object.keys(env).sort()).toEqual(['from', 'msg', 'to', 'v'])
    expect(Object.hasOwn(env, '__proto__')).toBe(false)
    expect(Object.keys(env.msg).sort()).toEqual(['c', 't'])
    if (env.msg.t !== 'ice') throw new Error('expected an ice message')
    expect(Object.keys(env.msg.c).sort()).toEqual(['candidate', 'sdpMLineIndex', 'sdpMid'])
    // Nothing anywhere in the process was polluted by the payload above.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})
```

Three things about the shape of this test, each preventing a specific way it
could pass while proving nothing:

- **Every hostile row is followed by re-parsing the good envelope, inside the
  same loop.** "Returns null and never throws" is satisfied perfectly by
  `return null`, which would break every WebRTC connection in the product while
  turning this file green. The paired assertion is what makes the rejection
  meaningful rather than universal.
- **The rows are `[label, value]` pairs iterated by hand, not `it.each`.**
  `it.each` spreads array rows: an `it.each` over raw values delivers `[]` as
  *zero arguments* and silently re-tests `undefined`. This project has confirmed
  that by watching a real bug pass under it.
- **`Object.hasOwn(env, '__proto__')`, not `'__proto__' in env`.** The `in`
  operator is `true` for every object via `Object.prototype`, so the `in` form is
  a tautology that never fails — the assertion would be decoration.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/signal.test.ts`

Expected: FAIL, before any assertion runs, with

```
Error: Cannot find module '../src/signal' imported from '<repo>/packages/net/test/signal.test.ts'
Caused by: Error: Failed to load url ../src/signal (resolved id: ../src/signal) ... Does the file exist?
 Test Files  1 failed (1)
```

- [ ] **Step 3: Write the implementation**

Create `packages/net/src/signal.ts`:

```ts
import type { IceCandidateInit } from './webrtc'

/**
 * PURE (contract §0a). Signalling is JSON over TEXT frames, not a WIRE_TAG
 * binary message (P4 Q12). Three reasons, stated so nobody "fixes" it: SDP is
 * already a multi-kilobyte UTF-8 blob and bit-packing it buys nothing;
 * MessageKind has no offer/answer/candidate members and adding three would put
 * pre-connection setup into the same union as race traffic; and a signalling
 * exchange a human can read in a devtools frame inspector is worth real
 * debugging hours on the one part of this system that fails in the field and
 * not in CI.
 *
 * The type-only import above closes a deliberate cycle with webrtc.ts, which
 * type-imports SignalMessage from here. Both edges are erased at runtime, so
 * there is no module cycle to break - only a compile-order note: `tsc` needs
 * both files present, vitest needs only the one under test.
 */
export const SIGNAL_VERSION = 1
/** An SDP with many candidates, with room. */
export const SIGNAL_MAX_BYTES = 16384

export type SignalMessage =
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; c: IceCandidateInit }
  | { t: 'iceDone' }
  | { t: 'giveUp'; reason: string }

/**
 * `from`/`to` are peer SLOTS (§4.2), so signalling and framing share one address
 * space and the server needs no second routing table.
 */
export interface SignalEnvelope {
  v: number
  from: number
  to: number
  msg: SignalMessage
}

export function encodeSignal(env: SignalEnvelope): string {
  return JSON.stringify(env)
}

/**
 * True only when `obj` carries these own keys and no others. JSON.parse DEFINES
 * a `__proto__` key as an own property rather than invoking the setter, so a
 * hostile payload's `__proto__` and `constructor` are visible here and are
 * rejected as what they are: keys this schema does not have. Strictness is
 * affordable because the envelope is versioned - a field added later arrives
 * with a new SIGNAL_VERSION.
 */
function hasExactKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(obj)
  if (keys.length !== allowed.length) return false
  for (const k of keys) {
    if (!allowed.includes(k)) return false
  }
  return true
}

/** Peer slots are one byte (§4.2), so anything outside 0..255 is not a slot. */
function isSlot(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255
}

function parseMessage(raw: unknown): SignalMessage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  switch (m['t']) {
    case 'offer':
      if (!hasExactKeys(m, ['t', 'sdp'])) return null
      return typeof m['sdp'] === 'string' ? { t: 'offer', sdp: m['sdp'] } : null
    case 'answer':
      if (!hasExactKeys(m, ['t', 'sdp'])) return null
      return typeof m['sdp'] === 'string' ? { t: 'answer', sdp: m['sdp'] } : null
    case 'ice': {
      if (!hasExactKeys(m, ['t', 'c'])) return null
      const c = m['c']
      if (typeof c !== 'object' || c === null || Array.isArray(c)) return null
      const cand = c as Record<string, unknown>
      if (!hasExactKeys(cand, ['candidate', 'sdpMid', 'sdpMLineIndex'])) return null
      if (typeof cand['candidate'] !== 'string') return null
      const sdpMid = cand['sdpMid']
      if (sdpMid !== null && typeof sdpMid !== 'string') return null
      const idx = cand['sdpMLineIndex']
      if (idx !== null && (typeof idx !== 'number' || !Number.isInteger(idx))) return null
      return { t: 'ice', c: { candidate: cand['candidate'], sdpMid, sdpMLineIndex: idx } }
    }
    case 'iceDone':
      return hasExactKeys(m, ['t']) ? { t: 'iceDone' } : null
    case 'giveUp':
      if (!hasExactKeys(m, ['t', 'reason'])) return null
      return typeof m['reason'] === 'string' ? { t: 'giveUp', reason: m['reason'] } : null
    default:
      return null
  }
}

/**
 * TOTAL. Returns null on malformed JSON, a wrong version, an over-long payload,
 * an unknown `t`, an unknown key, or any field of the wrong type. NEVER throws.
 *
 * The server calls this on every text frame from every socket, so it is the
 * single most attacker-reachable function in the project - and a throw out of a
 * socket handler is an uncaught exception that exits the process and kills every
 * room in it.
 *
 * `typeof text !== 'string'` is checked despite the signature: this is the first
 * thing that touches a value off the network, and a validator that throws on a
 * caller's mistake is a validator that turns a malformed request into a 500.
 */
export function parseSignal(text: string): SignalEnvelope | null {
  if (typeof text !== 'string') return null
  // UTF-16 code units are never more numerous than the UTF-8 bytes they encode
  // to, so this rejects everything genuinely over the cap before JSON.parse
  // touches it. It is an allocation bound, not a security boundary.
  if (text.length > SIGNAL_MAX_BYTES) return null

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null

  const env = raw as Record<string, unknown>
  if (!hasExactKeys(env, ['v', 'from', 'to', 'msg'])) return null
  if (env['v'] !== SIGNAL_VERSION) return null
  const from = env['from']
  const to = env['to']
  if (!isSlot(from) || !isSlot(to)) return null

  const msg = parseMessage(env['msg'])
  if (msg === null) return null

  // Field by field onto a fresh object literal, never a spread: `__proto__` and
  // `constructor` keys in a hostile payload then reach nothing at all.
  return { v: SIGNAL_VERSION, from, to, msg }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/signal.test.ts`

Expected: `Test Files  1 passed (1)` / `Tests  5 passed (5)`.

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
export * from './signal'
```

In `packages/net/test/barrel.test.ts`:

```ts
// 1. beside the other namespace imports:
import * as signalNs from '../src/signal'

// 2. inside `import type { ... } from '../src/index'`:
  // signal [Plan 4 Task 10]
  SignalEnvelope,
  SignalMessage,

// 3. in SURFACE:
  // [Plan 4 Task 10] JSON over text frames, beside the binary channel.
  signal: ['SIGNAL_MAX_BYTES', 'SIGNAL_VERSION', 'encodeSignal', 'parseSignal'],

// 4. in BARREL_MODULES, in the order index.ts lists them:
  'signal'

// 5. in NAMESPACES:
  ['signal', signalNs],

// 6. in `interface NetTypeSurface` / `const TYPE_SURFACE`:
  SignalEnvelope: SignalEnvelope  /  SignalEnvelope: true,
  SignalMessage: SignalMessage    /  SignalMessage: true,

// 7. in the sorted literal inside "pins the type-only surface at compile time",
//    in sorted position:
  'SignalEnvelope', 'SignalMessage',
```

- [ ] **Step 6: Verify the package, not just this file**

```bash
npx vitest run packages/net/test/signal.test.ts packages/net/test/barrel.test.ts
npx tsc --noEmit -p packages/net/tsconfig.json
npx vitest run
```

**Expected `tsc` result depends on Task 11:** clean if `packages/net/src/webrtc.ts`
exists, and exactly one `TS2307: Cannot find module './webrtc'` on line 1 if it
does not. Any *other* error is this task's. Both vitest runs must be green either
way — the barrel's `export * from './signal'` resolves at runtime with no help
from `webrtc.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/net/src/signal.ts packages/net/test/signal.test.ts \
        packages/net/src/index.ts packages/net/test/barrel.test.ts && \
git commit -m "feat(net): add the signalling envelope, total against every hostile text frame"
```
