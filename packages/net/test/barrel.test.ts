import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Top-level ESM import, not `require('@tapkart/sim')`: every package here sets
// "type": "module" and Vitest transforms to ESM, where `require` is undefined.
import { createState } from '@tapkart/sim'
import * as net from '../src/index'
import type {
  // clock [Task 15c]
  TickAccumulator,
  // transport [Task 11]
  Transport,
  // loopback [Task 12]
  LoopbackOptions,
  // client [Tasks 15, 15b]
  RemoteEntitySample,
  RemoteKeyframe,
  RemoteSample,
  // local [Task 15b]
  LocalInputTransport,
  // receive [Task 15b]
  DatagramGuard,
} from '../src/index'
import {
  AUTHORITY_CHANGE_BYTES,
  HOST_TIMEOUT_MS,
  MAX_CATCHUP_TICKS,
  REMOTE_BUFFER_CAPACITY,
  REMOTE_EXTRAPOLATE_CAP_MS,
  REMOTE_INTERP_DELAY_MS,
  SHADOW_HISTORY_TICKS,
  SNAPSHOT_PERIOD_TICKS,
  ShadowLoop,
  TICK_MS,
  createNullTransport,
  makeTickAccumulator,
} from '../src/index'

import { applyEvent as applyEventDirect } from '../src/apply'
import { advanceAccumulator as advanceAccumulatorDirect } from '../src/clock'
import { ShadowLoop as ShadowLoopDirect } from '../src/shadow'

// Every module as a namespace. The per-module expectations below are built from
// THESE and never from the barrel: an ambiguous `export *` is silently DROPPED
// from the ESM namespace object, so a check that derived its expectations from
// the barrel would be inspecting evidence the ambiguity has already destroyed.
import * as applyNs from '../src/apply'
import * as authorityNs from '../src/authority'
import * as clientNs from '../src/client'
import * as clockNs from '../src/clock'
import * as localNs from '../src/local'
import * as loopbackNs from '../src/loopback'
import * as receiveNs from '../src/receive'
import * as shadowNs from '../src/shadow'
import * as transportNs from '../src/transport'

// Imported so this file can assert, by name, that not one of them is reachable
// through the barrel. Fixtures shipping in the public surface is how they end up
// in the game bundle.
import * as goldenFixtureNs from './fixtures/golden-net'
import * as meshFixtureNs from './fixtures/mesh'
import * as netFixtureNs from './fixtures/net-fixtures'
import * as scriptedFixtureNs from './fixtures/scripted-input'
import * as spyFixtureNs from './fixtures/spy-transport'
import { makeNetContext } from './fixtures/net-fixtures'

const HERE = dirname(fileURLToPath(import.meta.url)) // packages/net/test
const SRC = join(HERE, '..', 'src')

/**
 * THE PUBLIC SURFACE OF @tapkart/net, PINNED EXACTLY.
 *
 * packages/net/package.json maps "." to src/index.ts, so this list IS what Plan
 * 3's game and Plan 4's server can see. Written per module rather than as one
 * flat set on purpose: a flat set cannot tell a name MOVING between modules from
 * a name staying put, and "which module owns this name" is exactly what an
 * `export *` barrel makes invisible at the import site.
 *
 * THE TRAP THIS AVOIDS: a barrel test that asserts "at least N names are
 * exported", or that spot-checks a handful, passes unchanged when one name is
 * silently deleted and another added. Every assertion below is an exact set
 * comparison in BOTH directions.
 */
const SURFACE: Record<string, string[]> = {
  // [Task 15c] TICK_MS moved here from client.ts (same binding, same barrel
  // surface); Plan 3's game clock and Plan 4's server ticker both reach for
  // advanceAccumulator, which must not come to exist twice.
  clock: ['MAX_CATCHUP_TICKS', 'TICK_MS', 'advanceAccumulator', 'makeTickAccumulator'],
  // [Task 11] Transport is an interface and erased at compile time, so this
  // module contributes NOTHING at runtime - a stronger version of protocol's
  // `types` exception, which at least had constants. The `export *` line is
  // still required and still checked below; it just carries no runtime name.
  transport: [],
  // [Task 12]
  loopback: ['makeLoopbackPair'],
  // [Task 13]
  apply: ['applyEvent'],
  // [Task 14]
  authority: ['AuthorityLoop', 'isDemoted'],
  // [Tasks 15, 15b] the renderer surface: remote karts and entities are only
  // ever read through the interpolator, never predicted.
  client: [
    'ClientLoop',
    'REMOTE_BUFFER_CAPACITY',
    'REMOTE_EXTRAPOLATE_CAP_MS',
    'REMOTE_INTERP_DELAY_MS',
    'RemoteInterpolator',
    'correctionDeltaOf',
    // [final fix pass, item C] sampleKart/sampleEntity take a caller-owned `out`
    // now, so the package has to say how to make one.
    'makeRemoteEntitySample',
    'makeRemoteSample',
    'remoteInterpolatorOf',
  ],
  // [Task 16] HOST_TIMEOUT_MS, not the HOST_TIMEOUT_TICKS an earlier draft
  // named: Task 15c item C moved host loss onto the scheduler's wall clock,
  // because a loop that has stopped ticking cannot notice with a tick counter.
  shadow: [
    'AUTHORITY_CHANGE_BYTES',
    'HOST_TIMEOUT_MS',
    'SHADOW_HISTORY_TICKS',
    'SNAPSHOT_PERIOD_TICKS',
    'ShadowLoop',
    'decodeAuthorityChange',
    'encodeAuthorityChange',
    // [final fix pass, item H] Plan 4's hub relays the authorityChange and every
    // peer recomputes promotionCursor(raceSeed, promotionTick) from it, so the
    // tick has to be readable from outside the loop.
    'promotionTickOf',
  ],
  // [Task 15b] the host's own input path - nothing else in this package lets a
  // host drive its kart.
  local: ['LOCAL_PEER_ID', 'createNullTransport', 'withLocalInput'],
  // [Task 15b] the datagram guard every loop's onMessage goes through, plus
  // [final fix pass] the wire-cursor plausibility bounds all three loops share.
  // Those are exported rather than kept private because they are protocol
  // facts, not receive-path trivia: Plan 4's server has to know that a peer
  // whose cursor has jumped further than MAX_CURSOR_ADVANCE_TICKS is one that
  // needs a checkpoint rather than another snapshot.
  receive: [
    'MAX_CURSOR_ADVANCE_EVENTS',
    'MAX_CURSOR_ADVANCE_TICKS',
    'MAX_WIRE_TICK',
    'createDatagramGuard',
    'droppedDatagramsOf',
    'eventCursorPlausible',
    'tickCursorPlausible',
  ],
}

/** The barrel's `export *` lines, in the order src/index.ts lists them. */
const BARREL_MODULES = [
  'clock', 'transport', 'loopback', 'apply', 'authority', 'client', 'shadow', 'local', 'receive',
]

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
]

/** Every module under test/, which must contribute nothing to the surface. */
const FIXTURES: [string, object][] = [
  ['fixtures/golden-net', goldenFixtureNs],
  ['fixtures/mesh', meshFixtureNs],
  ['fixtures/net-fixtures', netFixtureNs],
  ['fixtures/scripted-input', scriptedFixtureNs],
  ['fixtures/spy-transport', spyFixtureNs],
]

/**
 * The type-only half, pinned by the compiler: types are erased, so they cannot
 * appear in `Object.keys(net)` and a runtime test can say nothing about them.
 * `Record<keyof T, true>` makes it exact in both directions - a type removed
 * from the barrel fails the `import type` above, a type missing here fails the
 * Record, and a stray one fails as an excess property. All three are
 * `npm run typecheck` errors, since tsconfig.json includes test/**\/*.ts.
 */
interface NetTypeSurface {
  TickAccumulator: TickAccumulator
  Transport: Transport
  LoopbackOptions: LoopbackOptions
  RemoteKeyframe: RemoteKeyframe
  RemoteSample: RemoteSample
  RemoteEntitySample: RemoteEntitySample
  LocalInputTransport: LocalInputTransport
  DatagramGuard: DatagramGuard
}
const TYPE_SURFACE: Record<keyof NetTypeSurface, true> = {
  TickAccumulator: true,
  Transport: true,
  LoopbackOptions: true,
  RemoteKeyframe: true,
  RemoteSample: true,
  RemoteEntitySample: true,
  LocalInputTransport: true,
  DatagramGuard: true,
}

const expectedNames = (): string[] => Object.values(SURFACE).flat().sort()

describe('@tapkart/net barrel', () => {
  it('exports exactly this set of runtime names, and no others', () => {
    expect(Object.keys(net).sort()).toEqual(expectedNames())
  })

  it('sources each name from the module that owns it', () => {
    for (const [mod, ns] of NAMESPACES) {
      expect(Object.keys(ns).sort(), `${mod}'s own exports have changed`).toEqual([...SURFACE[mod]].sort())
    }
    expect(Object.keys(SURFACE).sort()).toEqual(NAMESPACES.map(([m]) => m).sort())
    // Stated rather than implied: transport.ts really does export nothing at
    // runtime, so the empty list above is a measurement and not an oversight.
    expect(Object.keys(transportNs)).toEqual([])
  })

  it('leaks no test fixture into the public surface', () => {
    // Not a spot-check of two names: EVERY export of EVERY module under test/,
    // enumerated from the fixture modules themselves so a fixture gaining a new
    // export is covered the day it does. A fixture reachable through the barrel
    // is a fixture in Plan 3's game bundle - and golden-net.ts alone drags in
    // node:fs and a 35 KB JSON file.
    const surface = new Set(Object.keys(net))
    for (const [mod, ns] of FIXTURES) {
      const names = Object.keys(ns)
      expect(names.length, `${mod} exports nothing, so this check proves nothing`).toBeGreaterThan(0)
      for (const name of names) {
        expect(surface.has(name), `${mod}.${name} is reachable through the public barrel`).toBe(false)
      }
    }
    // And the barrel cannot reach test/ at all, by construction.
    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    expect(barrel).not.toMatch(/from '\.\.?\/\.\./)
    expect(barrel).not.toMatch(/fixtures/)
  })

  it('has no ambiguous re-export', () => {
    const owners = new Map<string, string[]>()
    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) owners.set(key, [...(owners.get(key) ?? []), mod])
    }
    expect(Array.from(owners.entries()).filter(([, mods]) => mods.length > 1)).toEqual([])
    // An ambiguous name is dropped from the namespace object rather than
    // reported, so the count is what catches a drop the check above cannot see.
    expect(owners.size).toBe(Object.keys(net).length)
  })

  it('lists every module in src/ exactly once, and no test file', () => {
    const onDisk = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -3))
      .sort()
    expect(onDisk, 'a module was added to src/ without a line in the barrel').toEqual([...BARREL_MODULES].sort())

    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    for (const name of BARREL_MODULES) {
      const line = `export * from './${name}'`
      expect(barrel, `barrel is missing ${line}`).toContain(line)
      expect(barrel.split(line).length - 1, `${line} appears more than once`).toBe(1)
    }
    expect(barrel.match(/export \* from/g) ?? [], 'the barrel has an export line this test does not know about')
      .toHaveLength(BARREL_MODULES.length)
  })

  it('pins the type-only surface at compile time', () => {
    expect(Object.keys(TYPE_SURFACE).sort()).toEqual([
      'DatagramGuard', 'LocalInputTransport', 'LoopbackOptions', 'RemoteEntitySample',
      'RemoteKeyframe', 'RemoteSample', 'TickAccumulator', 'Transport',
    ])
  })

  it("re-exports each module's own binding, not a copy", () => {
    expect(ShadowLoop).toBe(ShadowLoopDirect)
    expect(net.applyEvent).toBe(applyEventDirect)
    expect(net.advanceAccumulator).toBe(advanceAccumulatorDirect)
  })

  it('carries the contract constants through unchanged', () => {
    expect(TICK_MS).toBe(1000 / 60)
    expect(MAX_CATCHUP_TICKS).toBe(5)
    expect(HOST_TIMEOUT_MS).toBe(1500) // spec §8: 1.5 s of no snapshot
    expect(SNAPSHOT_PERIOD_TICKS).toBe(3)
    expect(SHADOW_HISTORY_TICKS).toBe(24)
    expect(AUTHORITY_CHANGE_BYTES).toBe(10) // 2-byte shared header + two u32s
    expect(REMOTE_INTERP_DELAY_MS).toBe(100)
    expect(REMOTE_BUFFER_CAPACITY).toBe(8)
    expect(REMOTE_EXTRAPOLATE_CAP_MS).toBe(200)
    // No WIRE_TAG_* here: the message tags belong to @tapkart/protocol
    // (contract §3), and this barrel must not carry a second copy of them.
    expect(Object.keys(net).some((k) => k.startsWith('WIRE_TAG'))).toBe(false)
  })

  it('drives a ShadowLoop and a tick accumulator through the barrel alone', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x1, [0, 1, 2, 3, 4, 5, 6, 7])
    const shadow = new ShadowLoop(ctx, state, createNullTransport())
    shadow.tick(0)
    expect(state.tick).toBe(1)

    const acc = makeTickAccumulator()
    expect(net.advanceAccumulator(acc, TICK_MS * 3)).toBe(3)
  })

  it('resolves through the @tapkart/net package entry point', async () => {
    // The exact specifier Plan 3's game and Plan 4's server will use.
    const pkg = await import('@tapkart/net')
    expect(Object.keys(pkg).sort()).toEqual(expectedNames())
    expect(pkg.applyEvent).toBe(applyEventDirect)
  })
})
