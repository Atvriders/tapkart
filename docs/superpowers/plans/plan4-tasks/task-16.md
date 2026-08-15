### Task 16: `packages/server` opens — `src/types.ts` and `src/env.ts`, the single source of truth for configuration

**Files:**
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/src/types.ts`
- Create: `packages/server/src/env.ts`
- Create: `docs/server-env.md`
- Test: `packages/server/test/types.test.ts`
- Test: `packages/server/test/env.test.ts`

**Interfaces:**

- **Consumes** — from `@tapkart/sim`: `export const MAX_KARTS = 8`, and the types `SimContext`, `SimState`.
- **Consumes** — from `@tapkart/protocol` (contract §3.3): `export type PeerRole = 'host' | 'guest'`.
- **Consumes** — from `@tapkart/net`:

  ```ts
  export interface Transport { /* send, broadcast, onMessage, onPeerLost, peers, close */ }
  export class ShadowLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(nowMs: number): void; promote(tick: number): void }
  export interface TickAccumulator { residualMs: number }
  export interface LivenessState {
    lastSeenMs: number; lastPingSentMs: number; lastPingSeq: number
    rttMs: number; pingsSent: number; pongsSeen: number
  }
  export interface IceServerConfig { urls: string[]; username?: string; credential?: string }
  export const DEFAULT_ICE_SERVERS: readonly IceServerConfig[]   // = [{ urls: ['stun:stun.l.google.com:19302'] }]
  ```

- **Consumes** — a **forward type-only reference**: `RoomTransport` from `packages/server/src/roomtransport.ts` (contract §5.6), which a later task writes:

  ```ts
  export interface RoomTransport extends Transport {
    deliver(peerId: string, channel: ChannelName, payload: Uint8Array): void
    notePeerGone(peerId: string): void
  }
  ```

  `RaceRuntime.room` is typed `RoomTransport` in contract §5.1 and the module that owns it does not exist yet. The import is **`import type`**, which `verbatimModuleSyntax` erases before anything runs — vitest's esbuild transform strips it and never resolves the specifier, so this task's tests pass with the file absent. `tsc --noEmit -p packages/server/tsconfig.json` will report `Cannot find module './roomtransport'` until §5.6's task lands; that is expected sequencing and not this task's failure. **Do not stub the file**: a stub is a second definition of a locked interface, and the two would drift.

- **Produces** — contract §5.1, five exported symbols (census §11: `server/types` = 5): `PeerId`, `ServerRoomPhase`, `PeerRecord`, `RoomRecord`, `RaceRuntime`.

- **Produces** — contract §5.2, seven exported symbols (census §11: `server/env` = 7):

  ```ts
  export interface EnvVarSpec {
    name: string
    kind: 'number' | 'string' | 'boolean' | 'csv'
    required: boolean
    /** As a string, exactly as it would be written in a compose file. `null` when required. */
    defaultValue: string | null
    description: string
  }
  export const ENV_SCHEMA: readonly EnvVarSpec[]
  export interface RateLimitConfig { windowMs: number; max: number }
  export interface ServerConfig {
    port: number; bindHost: string; staticRoot: string
    maxRooms: number; maxPeersPerRoom: number; roomIdleMs: number
    joinRateLimit: RateLimitConfig
    iceServers: readonly IceServerConfig[]
    shadowEnabled: boolean
  }
  export const DEFAULT_CONFIG: Readonly<ServerConfig>
  export function parseConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig
  export function formatEnvTable(): string
  ```

**Why `env.ts` is a whole task's worth of care — C-6, quoted.** *"The container's environment did not match the server's parser, in two drafts written a day apart. That is not a naming slip, it is a missing single source of truth. `server/src/env.ts` declares every variable, its type, its default and whether it is required. The Dockerfile, the compose file and the README table are checked against it by a test that fails when they drift."*

And the defect that made it urgent, ruling **L3**: `parseConfig` throws on an unknown `TAPKART_*` variable, and Plan 5's compose file must set two of them for the assetlinks generator — so **the compose file C-6 exists to keep in step would have been the one thing preventing the server from booting.** Neither contract could see it alone; it is the third defect of that shape this project has produced. The fix is in this file: `ENV_SCHEMA` carries `TAPKART_ANDROID_PACKAGE` and `TAPKART_SHA256_FINGERPRINTS` with `required: false`, described as read by the entrypoint rather than by the server. Plan 5's CI then starts the container **with** them, so a regression here fails a build rather than an owner's deploy.

**Four decisions this task makes, because the contract fixes the signatures and not these:**

1. **`JOIN_RATE_WINDOW_MS = 60000` and `JOIN_RATE_MAX = 10`.** The contract names the two variables and no values. These bound F-P4-34's only attack — guessing a five-character code — and ten *failed* joins per code per minute is far above any human typo rate on a code you were told, while capping a guesser at 14,400 attempts a day against 33.5 M codes with rooms that live ten minutes. A successful join costs nothing, so a busy room is never limited.
2. **An empty value is a value, not an absence.** `ICE_SERVERS=` yields an **empty** ICE list — which is precisely what a self-hoster who objects to the third-party STUN default sets, and F-P4-16's disclosure promises them one variable to change. Only an *unset* variable takes its default.
3. **`parseConfig` does not reject an absolute `STATIC_ROOT`.** The *default* is relative — contract §0: *"An absolute default would bake a host path into a public repo"* — and a test asserts that. The image sets `/app/web`, because a container is not a checkout, and a parser that refused it would break the deployment C-6 exists to keep honest.
4. **`DEFAULT_CONFIG` is `parseConfig({})`, not a second literal.** Two hand-written copies of the same defaults is the drift C-6 was written about, in miniature.

---

- [ ] **Step 1: Create the package, then write the failing tests**

Create `packages/server/package.json` — contract §10.1, with one deliberate omission:

```json
{
  "name": "@tapkart/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./main": "./src/main.ts"
  },
  "dependencies": {
    "@tapkart/sim": "*",
    "@tapkart/protocol": "*",
    "@tapkart/net": "*",
    "@tapkart/content": "*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "build": "node scripts/build-server.mjs",
    "start": "node dist/main.mjs"
  }
}
```

**`ws` and `@types/ws` are deliberately absent.** Contract §10.1 pins them *"exactly, no caret — the pin task fixes the version"*, and the task that first imports `ws` (`src/runtime/ws.ts`, the only file in the repository allowed to) is the one that can read the installed version and pin it. Writing a guessed version here is how a dependency arrives unpinned and unnoticed.

Create `packages/server/tsconfig.json` — identical to `sim`, `protocol` and `net`, **with no `lib` override**, because R35 keeps DOM out of the four packages `server` imports and `server` itself has no use for it:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Then link the workspace:

```bash
npm install
```

Create `packages/server/test/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_KARTS } from '@tapkart/sim'
import type { PeerId, PeerRecord, RoomRecord, ServerRoomPhase } from '../src/types'
import { createLiveness } from '@tapkart/net'

function makePeer(peerId: PeerId, slot: number): PeerRecord {
  return {
    peerId,
    slot,
    playerId: -1,
    token: '',
    role: 'guest',
    name: '',
    characterIdx: 0,
    ready: false,
    relay: false,
    connected: true,
    joinedAtMs: 0,
    lastSeenMs: 0,
    liveness: createLiveness(0),
  }
}

function makeRoom(code: string): RoomRecord {
  return {
    code,
    createdAtMs: 0,
    lastActivityMs: 0,
    phase: 'lobby',
    hostPeerId: null,
    hostPlayerId: -1,
    trackId: '',
    lobbyVersion: 0,
    raceSeed: 0,
    peers: new Map(),
    slotsInUse: new Set(),
    seats: new Array<PeerId | null>(MAX_KARTS).fill(null),
    rtcFailures: 0,
    race: null,
  }
}

describe('server types', () => {
  it('gives a room one seat per kart, all empty', () => {
    const room = makeRoom('ABCDE')
    expect(room.seats).toHaveLength(MAX_KARTS)
    expect(room.seats.every((s) => s === null)).toBe(true)
  })

  it('separates the ROOM phase from the race phase', () => {
    // F-P4-31: "host-authoritative" is about the race simulation, not the
    // lobby, and conflating the two is what makes host-owned lobby truth look
    // tempting. ServerRoomPhase has no 'countdown' and SimState.phase has no
    // 'lobby'; nothing can assign one to the other.
    const phases: ServerRoomPhase[] = ['lobby', 'racing', 'finished', 'closed']
    expect(phases).toHaveLength(4)
    const room = makeRoom('ABCDE')
    room.phase = 'racing'
    expect(room.phase).toBe('racing')
  })

  it('carries a peer per id and a slot per peer, with no race attached yet', () => {
    const room = makeRoom('ABCDE')
    const peer = makePeer('peer-1', 3)
    room.peers.set(peer.peerId, peer)
    room.slotsInUse.add(peer.slot)

    expect(room.peers.get('peer-1')?.slot).toBe(3)
    expect(room.peers.get('peer-1')?.playerId).toBe(-1) // -1 until seated
    expect(room.race).toBeNull()
  })

  it('gives every peer its own liveness state', () => {
    const a = makePeer('a', 1)
    const b = makePeer('b', 2)
    a.liveness.lastSeenMs = 5000
    expect(b.liveness.lastSeenMs).toBe(0)
  })
})
```

Create `packages/server/test/env.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ICE_SERVERS } from '@tapkart/net'
import { MAX_KARTS } from '@tapkart/sim'
import type { EnvVarSpec } from '../src/env'
import { DEFAULT_CONFIG, ENV_SCHEMA, formatEnvTable, parseConfig } from '../src/env'

const HERE = dirname(fileURLToPath(import.meta.url)) // packages/server/test
const ENV_DOC = join(HERE, '..', '..', '..', 'docs', 'server-env.md')

const specOf = (name: string): EnvVarSpec => {
  const spec = ENV_SCHEMA.find((s) => s.name === name)
  if (!spec) throw new Error(`ENV_SCHEMA has no ${name}`)
  return spec
}

describe('ENV_SCHEMA', () => {
  it('names every variable exactly once', () => {
    const names = ENV_SCHEMA.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('declares the twelve variables this server recognises', () => {
    expect(ENV_SCHEMA.map((s) => s.name)).toEqual([
      'PORT',
      'BIND_HOST',
      'STATIC_ROOT',
      'MAX_ROOMS',
      'MAX_PEERS_PER_ROOM',
      'ROOM_IDLE_MS',
      'JOIN_RATE_WINDOW_MS',
      'JOIN_RATE_MAX',
      'ICE_SERVERS',
      'SHADOW_ENABLED',
      'TAPKART_ANDROID_PACKAGE',
      'TAPKART_SHA256_FINGERPRINTS',
    ])
  })

  it('gives every optional variable a default, and every default parses', () => {
    for (const spec of ENV_SCHEMA) {
      if (spec.required) expect(spec.defaultValue).toBeNull()
      else expect(typeof spec.defaultValue).toBe('string')
      expect(spec.description.length).toBeGreaterThan(0)
      // Set explicitly to its own documented default: if a default cannot be
      // parsed by the parser that declares it, the schema is not one source of
      // truth, it is two.
      expect(() => parseConfig({ [spec.name]: spec.defaultValue ?? '' })).not.toThrow()
    }
  })

  it('keeps every default path relative, so no host path is baked into a public repo', () => {
    const staticRoot = specOf('STATIC_ROOT').defaultValue ?? ''
    expect(staticRoot).toBe('apps/web/dist')
    expect(staticRoot.startsWith('/')).toBe(false)
    expect(staticRoot).not.toMatch(/^[A-Za-z]:/)
    expect(staticRoot).not.toContain('..')
  })

  it('names no real host anywhere in its defaults', () => {
    for (const spec of ENV_SCHEMA) {
      const value = spec.defaultValue ?? ''
      expect(value).not.toMatch(/\b192\.168\.|\b10\.\d+\.|\b172\.(1[6-9]|2\d|3[01])\./)
      // 0.0.0.0 is a bind wildcard, not a host, and the STUN URL is a public
      // third-party service address (F-P4-16), disclosed in docs/server-env.md.
      if (value !== '0.0.0.0' && spec.name !== 'ICE_SERVERS') {
        expect(value).not.toMatch(/\d+\.\d+\.\d+\.\d+/)
      }
    }
  })
})

describe('parseConfig - defaults', () => {
  it('is what DEFAULT_CONFIG holds', () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG)
  })

  it('produces the values spec §9 and contract §5.2 fix', () => {
    const cfg = parseConfig({})
    expect(cfg.port).toBe(3031)
    expect(cfg.bindHost).toBe('0.0.0.0')
    expect(cfg.staticRoot).toBe('apps/web/dist')
    expect(cfg.maxRooms).toBe(64)
    expect(cfg.maxPeersPerRoom).toBe(MAX_KARTS)
    expect(cfg.roomIdleMs).toBe(600_000)
    expect(cfg.joinRateLimit).toEqual({ windowMs: 60_000, max: 10 })
    expect(cfg.shadowEnabled).toBe(true)
    expect(cfg.iceServers).toEqual(DEFAULT_ICE_SERVERS)
  })

  it('ignores variables that are not ours', () => {
    expect(() =>
      parseConfig({ PATH: '/usr/bin', HOME: '/root', NODE_ENV: 'production', HOSTNAME: 'container' }),
    ).not.toThrow()
  })
})

describe('parseConfig - overrides', () => {
  it('reads every variable it declares', () => {
    const cfg = parseConfig({
      PORT: '8080',
      BIND_HOST: '127.0.0.1',
      STATIC_ROOT: '/app/web',
      MAX_ROOMS: '4',
      MAX_PEERS_PER_ROOM: '2',
      ROOM_IDLE_MS: '1000',
      JOIN_RATE_WINDOW_MS: '5000',
      JOIN_RATE_MAX: '3',
      ICE_SERVERS: 'stun:stun.example:3478,turns:relay.example:5349',
      SHADOW_ENABLED: 'false',
    })
    expect(cfg.port).toBe(8080)
    expect(cfg.bindHost).toBe('127.0.0.1')
    expect(cfg.staticRoot).toBe('/app/web') // an ABSOLUTE override is legal: the image is not a checkout
    expect(cfg.maxRooms).toBe(4)
    expect(cfg.maxPeersPerRoom).toBe(2)
    expect(cfg.roomIdleMs).toBe(1000)
    expect(cfg.joinRateLimit).toEqual({ windowMs: 5000, max: 3 })
    expect(cfg.iceServers).toEqual([
      { urls: ['stun:stun.example:3478'] },
      { urls: ['turns:relay.example:5349'] },
    ])
    expect(cfg.shadowEnabled).toBe(false)
  })

  it('treats an empty ICE_SERVERS as "no STUN", not as the default', () => {
    // F-P4-16 promises a self-hoster who objects to the third-party endpoint
    // ONE variable to change. Falling back to the default here would take that
    // away silently.
    expect(parseConfig({ ICE_SERVERS: '' }).iceServers).toEqual([])
  })
})

describe('parseConfig - refusing rather than defaulting', () => {
  it('throws with the variable NAME in the message on a bad number', () => {
    expect(() => parseConfig({ MAX_ROOMS: 'lots' })).toThrow(/MAX_ROOMS/)
    expect(() => parseConfig({ ROOM_IDLE_MS: '12.5' })).toThrow(/ROOM_IDLE_MS/)
    expect(() => parseConfig({ JOIN_RATE_MAX: '-1' })).toThrow(/JOIN_RATE_MAX/)
    expect(() => parseConfig({ PORT: '' })).toThrow(/PORT/)
  })

  it('throws on a port outside 0..65535', () => {
    expect(() => parseConfig({ PORT: '70000' })).toThrow(/PORT/)
    expect(parseConfig({ PORT: '0' }).port).toBe(0) // an ephemeral bind is legal
  })

  it('throws with the NAME on a boolean that is not true or false', () => {
    expect(() => parseConfig({ SHADOW_ENABLED: '1' })).toThrow(/SHADOW_ENABLED/)
    expect(() => parseConfig({ SHADOW_ENABLED: 'yes' })).toThrow(/SHADOW_ENABLED/)
    expect(parseConfig({ SHADOW_ENABLED: 'true' }).shadowEnabled).toBe(true)
  })

  it('throws on an unknown TAPKART_ variable, naming it', () => {
    // That prefix is ours and a typo in it is always a mistake. A server that
    // starts with a silently-defaulted misspelled variable is worse than one
    // that refuses.
    expect(() => parseConfig({ TAPKART_SHADOW_ENABLED: 'true' })).toThrow(/TAPKART_SHADOW_ENABLED/)
    // TAPKART_ORIGIN is a BUILD variable (C-3, L2) and is deliberately not a
    // container variable, so it must be refused here too.
    expect(() => parseConfig({ TAPKART_ORIGIN: 'https://tapkart.example' })).toThrow(/TAPKART_ORIGIN/)
  })

  it('ACCEPTS the two TAPKART_ variables the container really sets (L3)', () => {
    // The defect this row exists for: as the two contracts stood, the compose
    // file C-6 exists to keep in step was the one thing that would stop the
    // server booting.
    expect(() =>
      parseConfig({
        TAPKART_ANDROID_PACKAGE: 'com.example.tapkart',
        TAPKART_SHA256_FINGERPRINTS: 'DE:AD:BE:EF',
      }),
    ).not.toThrow()
    // And they change nothing about the server's own configuration.
    expect(
      parseConfig({ TAPKART_ANDROID_PACKAGE: 'com.example.tapkart', TAPKART_SHA256_FINGERPRINTS: 'DE:AD' }),
    ).toEqual(DEFAULT_CONFIG)
  })
})

describe('formatEnvTable and docs/server-env.md', () => {
  it('is a Markdown table with one row per variable', () => {
    const table = formatEnvTable()
    const lines = table.split('\n')
    expect(lines[0]).toBe('| Variable | Type | Required | Default | Description |')
    expect(lines[1]).toBe('| --- | --- | --- | --- | --- |')
    expect(lines).toHaveLength(ENV_SCHEMA.length + 2)
    for (const spec of ENV_SCHEMA) {
      expect(table).toContain(`| \`${spec.name}\` |`)
    }
  })

  it('is contained in docs/server-env.md, byte for byte', () => {
    // The drift test C-6 asks for. Plan 5 asserts its Dockerfile and compose
    // file against ENV_SCHEMA directly; this is Plan 4's half.
    const doc = readFileSync(ENV_DOC, 'utf8')
    expect(doc).toContain(formatEnvTable())
  })

  it('discloses the third-party STUN endpoint and how to change it', () => {
    // F-P4-16: "documented in the README as a third-party endpoint contacted at
    // connection time, so a self-hoster who objects can change one variable.
    // Disclosure is the answer to the privacy cost."
    const doc = readFileSync(ENV_DOC, 'utf8')
    expect(doc).toContain('stun:stun.l.google.com:19302')
    expect(doc).toMatch(/third-party/i)
    expect(doc).toContain('ICE_SERVERS')
  })

  it('names no LAN address or real hostname', () => {
    const doc = readFileSync(ENV_DOC, 'utf8')
    expect(doc).not.toMatch(/\b192\.168\.|\b10\.\d+\.\d+\.\d+/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/server`

Expected: FAIL — both files, before any assertion, with

```
Error: Failed to resolve import "../src/types" from "packages/server/test/types.test.ts". Does the file exist?
Error: Failed to resolve import "../src/env" from "packages/server/test/env.test.ts". Does the file exist?
```

- [ ] **Step 3: Write `packages/server/src/types.ts`**

```ts
// PURE (contract §0a): type declarations only. Nothing in this file runs.
import type { PeerRole } from '@tapkart/protocol'
import type { SimContext, SimState } from '@tapkart/sim'
import type { LivenessState, ShadowLoop, TickAccumulator, Transport } from '@tapkart/net'
// FORWARD, TYPE-ONLY. src/roomtransport.ts is contract §5.6's module and a later
// task writes it; `import type` is erased under verbatimModuleSyntax, so nothing
// resolves this specifier at run time. Do not stub that file: a stub is a second
// definition of a locked interface.
import type { RoomTransport } from './roomtransport'

export type PeerId = string

/** The ROOM's phase, which is lobby bookkeeping. Not `SimState.phase`, which is
 *  the race's. F-P4-31 keeps them separate on purpose: "host-authoritative" is
 *  about the race simulation, and conflating the two is what makes
 *  host-owned lobby truth look tempting - it fails at exactly the moment this
 *  whole plan exists to survive, the host backgrounding a browser tab. */
export type ServerRoomPhase = 'lobby' | 'racing' | 'finished' | 'closed'

export interface PeerRecord {
  peerId: PeerId
  slot: number            // 1..254
  playerId: number        // -1 until seated
  token: string
  role: PeerRole
  name: string
  characterIdx: number
  ready: boolean
  relay: boolean          // true once CLIENT_FLAG_RTC_FAILED arrived
  connected: boolean
  joinedAtMs: number
  lastSeenMs: number
  liveness: LivenessState
}

export interface RoomRecord {
  code: string
  createdAtMs: number
  lastActivityMs: number
  phase: ServerRoomPhase
  /** The peer who CREATED the room. Unchanged by promotion: promotion re-seats
   *  the race authority, not the lobby owner (F-P4-31). A returning demoted host
   *  still owns the lobby and may still start the next race. */
  hostPeerId: PeerId | null
  hostPlayerId: number
  trackId: string
  lobbyVersion: number
  raceSeed: number
  peers: Map<PeerId, PeerRecord>
  slotsInUse: Set<number>
  seats: (PeerId | null)[]      // length MAX_KARTS, index === playerId
  /** F-P4-39: consecutive guests that gave up on WebRTC to this host. At
   *  RELAY_FIRST_AFTER_FAILURES, further guests attach over the relay
   *  immediately and attempt WebRTC in the background. */
  rtcFailures: number
  race: RaceRuntime | null
}

export interface RaceRuntime {
  /** FRESH per race - never shared, never memoised. ShadowLoop.promote() writes
   *  `ctx.isLeader = true` into the object it was handed, so one shared context
   *  would let a single host dropping turn every room in the process into a
   *  leader. Contract §7.1. */
  ctx: SimContext
  state: SimState
  shadow: ShadowLoop
  transport: Transport          // withPeerAuthority(roomTransport, ...)
  room: RoomTransport           // the undecorated one, for deliver/notePeerGone
  /** @tapkart/net's, not a server copy (F-P4-7). One field, `residualMs`. */
  acc: TickAccumulator
  /** The previous `stepRace` timestamp. It lives here rather than in the
   *  accumulator because `advanceAccumulator` takes an elapsed delta. */
  lastPollMs: number
  startedAtMs: number
}
```

The census is the check: this module exports exactly five names — `PeerId`, `ServerRoomPhase`, `PeerRecord`, `RoomRecord`, `RaceRuntime`. Add no sixth, not even a convenience alias, because `src/index.ts` re-exports this file wholesale and the barrel test asserts an exact set.

**`RaceRuntime` has no `hostWatch`, no `promoted` and no `promotionTick`** (F-P4-22, GAP-4). Promotion state lives in exactly one place — the `ShadowLoop` — and the server reads it with `shadow.promotionTick()`.

- [ ] **Step 4: Write `packages/server/src/env.ts`**

```ts
// PURE (contract §0a). `process` is never touched here: the environment is
// PASSED IN, which is what makes every branch below a unit test.
import type { IceServerConfig } from '@tapkart/net'
import { DEFAULT_ICE_SERVERS } from '@tapkart/net'
import { MAX_KARTS } from '@tapkart/sim'

export interface EnvVarSpec {
  name: string
  kind: 'number' | 'string' | 'boolean' | 'csv'
  required: boolean
  /** As a string, exactly as it would be written in a compose file. `null` when
   *  required. */
  defaultValue: string | null
  description: string
}

/** The prefix that is ours. A typo in it is always a mistake, so an unknown
 * variable carrying it is refused rather than ignored. */
const TAPKART_PREFIX = 'TAPKART_'

/** The one STUN URL, written once and read by both the schema default and the
 * disclosure paragraph in docs/server-env.md. */
const DEFAULT_ICE_URLS = DEFAULT_ICE_SERVERS.flatMap((s) => s.urls).join(',')

/**
 * EVERY variable this server recognises, in one array. The Dockerfile, the
 * compose file and the README table are checked against THIS by a test that
 * fails when they drift - Plan 4 asserts docs/server-env.md, Plan 5 asserts its
 * two container files against the same export. A variable that exists in one
 * and not the other is a build failure, not a 3 a.m. discovery.
 */
export const ENV_SCHEMA: readonly EnvVarSpec[] = [
  {
    name: 'PORT',
    kind: 'number',
    required: false,
    defaultValue: '3031',
    description: 'The port the HTTP and WebSocket server binds. Spec §9.',
  },
  {
    name: 'BIND_HOST',
    kind: 'string',
    required: false,
    defaultValue: '0.0.0.0',
    description: 'The address to bind. A wildcard, never a real hostname.',
  },
  {
    name: 'STATIC_ROOT',
    kind: 'string',
    required: false,
    defaultValue: 'apps/web/dist',
    description:
      'The web build to serve, relative to the working directory. `<STATIC_ROOT>/.well-known/` is the one well-known directory.',
  },
  {
    name: 'MAX_ROOMS',
    kind: 'number',
    required: false,
    defaultValue: '64',
    description: 'Rooms per process. At the cap a create is refused rather than a live race evicted.',
  },
  {
    name: 'MAX_PEERS_PER_ROOM',
    kind: 'number',
    required: false,
    defaultValue: String(MAX_KARTS),
    description: 'Peers per room. The ninth joiner is refused with `roomFull`; there are no spectators.',
  },
  {
    name: 'ROOM_IDLE_MS',
    kind: 'number',
    required: false,
    defaultValue: '600000',
    description: 'How long a room may sit idle before it is closed.',
  },
  {
    name: 'JOIN_RATE_WINDOW_MS',
    kind: 'number',
    required: false,
    defaultValue: '60000',
    description: 'The failed-join window, counted per ROOM CODE and never per IP.',
  },
  {
    name: 'JOIN_RATE_MAX',
    kind: 'number',
    required: false,
    defaultValue: '10',
    description: 'Failed joins allowed per room code per window. A successful join costs nothing.',
  },
  {
    name: 'ICE_SERVERS',
    kind: 'csv',
    required: false,
    defaultValue: DEFAULT_ICE_URLS,
    description:
      'Comma-separated ICE URLs. The default is a third-party endpoint contacted at connection time; set it empty to use none.',
  },
  {
    name: 'SHADOW_ENABLED',
    kind: 'boolean',
    required: false,
    defaultValue: 'true',
    description: 'Run a shadow authority per room. With it off there is no host-loss detector and no promotion at all.',
  },
  {
    name: 'TAPKART_ANDROID_PACKAGE',
    kind: 'string',
    required: false,
    defaultValue: '',
    description: "Read by the container entrypoint's assetlinks generator, never by the server.",
  },
  {
    name: 'TAPKART_SHA256_FINGERPRINTS',
    kind: 'csv',
    required: false,
    defaultValue: '',
    description: 'Comma-separated signing-certificate fingerprints, read by the same generator and never by the server.',
  },
]

export interface RateLimitConfig { windowMs: number; max: number }

export interface ServerConfig {
  port: number
  bindHost: string
  staticRoot: string
  maxRooms: number
  maxPeersPerRoom: number
  roomIdleMs: number
  joinRateLimit: RateLimitConfig
  iceServers: readonly IceServerConfig[]
  shadowEnabled: boolean
}

const KNOWN_NAMES: ReadonlySet<string> = new Set(ENV_SCHEMA.map((s) => s.name))

function specOf(name: string): EnvVarSpec {
  const spec = ENV_SCHEMA.find((s) => s.name === name)
  if (!spec) throw new Error(`env: ${name} is not in ENV_SCHEMA`)
  return spec
}

/**
 * The raw string for `name`. An UNSET variable takes its default; an EMPTY one
 * does not - `ICE_SERVERS=` means "no ICE servers", which is exactly what a
 * self-hoster who objects to the third-party default sets, and falling back to
 * the default there would take away the one variable F-P4-16 promises them.
 */
function rawOf(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const spec = specOf(name)
  const value = env[name]
  if (value !== undefined) return value
  if (spec.defaultValue === null) {
    throw new Error(`${name}: required and not set`)
  }
  return spec.defaultValue
}

function numberOf(env: Readonly<Record<string, string | undefined>>, name: string): number {
  const raw = rawOf(env, name).trim()
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name}: expected an integer, got "${raw}"`)
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${name}: expected a non-negative integer, got "${raw}"`)
  }
  return n
}

function booleanOf(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const raw = rawOf(env, name).trim()
  if (raw === 'true') return true
  if (raw === 'false') return false
  // Refusing '1' and 'yes' is deliberate: a boolean that silently defaults to
  // true on an unrecognised value is a feature flag nobody can tell is off.
  throw new Error(`${name}: expected "true" or "false", got "${raw}"`)
}

function csvOf(env: Readonly<Record<string, string | undefined>>, name: string): string[] {
  return rawOf(env, name)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * Pure over a plain record - `process.env` is passed in, never read here.
 * Throws with the offending variable's NAME in the message; a server that
 * starts with a silently-defaulted misspelled variable is worse than one that
 * refuses. An UNKNOWN variable is ignored (the container's environment is not
 * ours alone), but an unknown variable with the prefix `TAPKART_` throws,
 * because that prefix is ours and a typo in it is always a mistake.
 *
 * The two TAPKART_ variables in ENV_SCHEMA are therefore accepted and unused:
 * Plan 5's compose file sets them for the assetlinks generator, and without
 * their rows here the compose file C-6 exists to keep in step would be the one
 * thing preventing the server from booting (ruling L3).
 */
export function parseConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  for (const key of Object.keys(env)) {
    if (key.startsWith(TAPKART_PREFIX) && !KNOWN_NAMES.has(key)) {
      throw new Error(
        `${key}: unknown ${TAPKART_PREFIX} variable. Every variable this server recognises is in ENV_SCHEMA (docs/server-env.md).`,
      )
    }
  }

  const port = numberOf(env, 'PORT')
  if (port > 65535) {
    throw new Error(`PORT: expected a port in 0..65535, got "${port}"`)
  }

  return {
    port,
    bindHost: rawOf(env, 'BIND_HOST'),
    // NOT checked for absoluteness: the DEFAULT is relative (contract §0, so no
    // host path is baked into a public repo), and the image legitimately sets
    // /app/web because a container is not a checkout.
    staticRoot: rawOf(env, 'STATIC_ROOT'),
    maxRooms: numberOf(env, 'MAX_ROOMS'),
    maxPeersPerRoom: numberOf(env, 'MAX_PEERS_PER_ROOM'),
    roomIdleMs: numberOf(env, 'ROOM_IDLE_MS'),
    joinRateLimit: {
      windowMs: numberOf(env, 'JOIN_RATE_WINDOW_MS'),
      max: numberOf(env, 'JOIN_RATE_MAX'),
    },
    iceServers: csvOf(env, 'ICE_SERVERS').map((url) => ({ urls: [url] })),
    shadowEnabled: booleanOf(env, 'SHADOW_ENABLED'),
  }
}

/** Derived from the schema, never a second literal: two hand-written copies of
 * the same defaults is the drift C-6 was written about, in miniature. */
export const DEFAULT_CONFIG: Readonly<ServerConfig> = parseConfig({})

function renderDefault(spec: EnvVarSpec): string {
  if (spec.defaultValue === null) return '—'
  if (spec.defaultValue === '') return '`""`'
  return `\`${spec.defaultValue}\``
}

/** ENV_SCHEMA as the exact Markdown table `docs/server-env.md` contains. The
 *  drift test is `expect(readFileSync(...)).toContain(formatEnvTable())`. */
export function formatEnvTable(): string {
  const lines = ['| Variable | Type | Required | Default | Description |', '| --- | --- | --- | --- | --- |']
  for (const spec of ENV_SCHEMA) {
    lines.push(
      `| \`${spec.name}\` | ${spec.kind} | ${spec.required ? 'yes' : 'no'} | ${renderDefault(spec)} | ${spec.description} |`,
    )
  }
  return lines.join('\n')
}
```

**`WELL_KNOWN_DIR` and `TRACKS_DIR` do not exist** and no task may add them: C-2 keeps Plan 5's generator writing `<staticRoot>/.well-known/assetlinks.json`, so there is exactly one well-known directory and it is derived from `staticRoot` — one variable instead of two that must agree. `TRACKS_DIR` is deleted by R46: tracks are imported from `@tapkart/content`, never read from disk. **`TAPKART_ORIGIN` is not here** (C-3, L2): it is a build-time variable for the APK and `assetlinks.json` only, and `parseConfig` refuses it as an unknown `TAPKART_*` name.

- [ ] **Step 5: Write `docs/server-env.md`**

The table below must match `formatEnvTable()` **byte for byte** — every description is the same string as `ENV_SCHEMA`'s, character for character, including the `§` and the backticks. Write the file exactly as given:

```markdown
# Server environment

Every variable `@tapkart/server` recognises, generated from `ENV_SCHEMA` in
`packages/server/src/env.ts`. That module is the single source of truth: the
container files and this table are asserted against it by tests, so a variable
that exists in one and not the other is a build failure rather than a 3 a.m.
discovery.

Two rules the parser enforces:

- An **unknown** variable is ignored — the container's environment is not ours
  alone — but an unknown variable beginning `TAPKART_` **throws with its own
  name in the message**, because that prefix is ours and a typo in it is always
  a mistake.
- An **unset** variable takes its default. An **empty** one does not:
  `ICE_SERVERS=` means "no ICE servers at all".

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `PORT` | number | no | `3031` | The port the HTTP and WebSocket server binds. Spec §9. |
| `BIND_HOST` | string | no | `0.0.0.0` | The address to bind. A wildcard, never a real hostname. |
| `STATIC_ROOT` | string | no | `apps/web/dist` | The web build to serve, relative to the working directory. `<STATIC_ROOT>/.well-known/` is the one well-known directory. |
| `MAX_ROOMS` | number | no | `64` | Rooms per process. At the cap a create is refused rather than a live race evicted. |
| `MAX_PEERS_PER_ROOM` | number | no | `8` | Peers per room. The ninth joiner is refused with `roomFull`; there are no spectators. |
| `ROOM_IDLE_MS` | number | no | `600000` | How long a room may sit idle before it is closed. |
| `JOIN_RATE_WINDOW_MS` | number | no | `60000` | The failed-join window, counted per ROOM CODE and never per IP. |
| `JOIN_RATE_MAX` | number | no | `10` | Failed joins allowed per room code per window. A successful join costs nothing. |
| `ICE_SERVERS` | csv | no | `stun:stun.l.google.com:19302` | Comma-separated ICE URLs. The default is a third-party endpoint contacted at connection time; set it empty to use none. |
| `SHADOW_ENABLED` | boolean | no | `true` | Run a shadow authority per room. With it off there is no host-loss detector and no promotion at all. |
| `TAPKART_ANDROID_PACKAGE` | string | no | `""` | Read by the container entrypoint's assetlinks generator, never by the server. |
| `TAPKART_SHA256_FINGERPRINTS` | csv | no | `""` | Comma-separated signing-certificate fingerprints, read by the same generator and never by the server. |

## The STUN default is a third-party endpoint

`ICE_SERVERS` defaults to `stun:stun.l.google.com:19302`, a **third-party
endpoint contacted at connection time**: every peer that attempts a direct
WebRTC connection sends STUN binding requests to it, which discloses the peer's
address to that service.

It is a default rather than an omission because an empty one means WebRTC only
ever succeeds on the same LAN — so essentially every real guest falls back to
the WebSocket relay and this server carries the whole race, which is a different
product rather than a conservative setting.

To use your own, set one variable:

```
ICE_SERVERS=stun:stun.example:3478
```

To use none at all, set it empty. Guests who cannot reach the host directly then
attach over the relay, which this server implements and which needs no STUN.

## Why failed joins are limited per room code

Room codes are five characters from a 32-symbol alphabet (33,554,432 of them)
and rooms live about ten minutes, so guessing one is already impractical.
`JOIN_RATE_WINDOW_MS` and `JOIN_RATE_MAX` bound it further — **per room code,
never per client address**. Behind a tunnel or a reverse proxy every request can
arrive from one peer, which makes address-keyed limiting either useless or a
building-wide outage, and trusting a forwarding header is only correct while the
deployment is behind the thing that sets it.
```

**If Step 6's byte-for-byte test fails**, the fix is always in one direction: the doc follows the schema. Run

```bash
npx vitest run packages/server/test/env.test.ts -t 'byte for byte'
```

and replace the table block in `docs/server-env.md` with the string the failure prints. Never edit a description in `env.ts` to match the doc — the doc is the copy.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/server`

Expected: PASS, 23 tests (4 in `types.test.ts`, 19 in `env.test.ts`).

`npx tsc --noEmit -p packages/server/tsconfig.json` is **expected to report `Cannot find module './roomtransport'`** until contract §5.6's task lands, and nothing else. Any other error is this task's.

- [ ] **Step 7: Commit**

```bash
git add packages/server/package.json packages/server/tsconfig.json packages/server/src/types.ts packages/server/src/env.ts packages/server/test/types.test.ts packages/server/test/env.test.ts docs/server-env.md package-lock.json && git commit -m "feat(server): room and peer records, and one env schema that is the source of truth

ENV_SCHEMA declares all twelve variables with type, default and description;
parseConfig is pure over a passed-in record, refuses an unknown TAPKART_ name,
and ACCEPTS the two the container really sets (L3) so the compose file cannot
stop the server booting. formatEnvTable is asserted against docs/server-env.md."
```
