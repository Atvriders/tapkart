import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CHARACTERS, TRACK_MANIFEST, TUNING, loadTrack } from '@tapkart/content'
import {
  HOST_TIMEOUT_MS,
  MAX_CATCHUP_TICKS,
  ShadowLoop,
  createNullTransport,
  promotionTickOf,
} from '@tapkart/net'
import {
  LOBBY_PATH_PREFIX,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  lobbyPathFor,
} from '@tapkart/protocol'
import { MAX_KARTS, createState } from '@tapkart/sim'
import type { SimContext } from '@tapkart/sim'

/**
 * The scaffold guard, and the runtime half of the Plan 2 + Plan 3 gate.
 *
 * Step 1's `tsc` check proves every name Plan 4 imports EXISTS and has the
 * stated SHAPE. It cannot prove that the four packages compose in one process,
 * and composition is where this project has repeatedly found its gaps. So this
 * file constructs a real `SimContext` out of `@tapkart/content`, hands it to
 * `@tapkart/sim`'s `createState` and then to `@tapkart/net`'s `ShadowLoop` -
 * the exact three-package path the server's per-room shadow authority takes -
 * and asserts the one read-only helper the server needs off the far end of it.
 */

const HERE = dirname(fileURLToPath(import.meta.url)) // packages/server/test
const PKG_ROOT = join(HERE, '..') // packages/server
const REPO_ROOT = join(PKG_ROOT, '..', '..')

const readJson = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

describe('packages/server scaffold', () => {
  it('is contract §10.1\'s manifest, exactly', () => {
    const pkg = readJson(join(PKG_ROOT, 'package.json'))
    expect(pkg.name).toBe('@tapkart/server')
    expect(pkg.version).toBe('0.1.0')
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe('module')
    // Two entries, and the second is deliberate: it keeps main.ts reachable to
    // the build script while keeping it out of the headless barrel (§0).
    expect(pkg.exports).toEqual({ '.': './src/index.ts', './main': './src/main.ts' })
  })

  it('declares exactly the five dependencies spec §3 allows, and never game or render', () => {
    const pkg = readJson(join(PKG_ROOT, 'package.json'))
    const deps = pkg.dependencies as Record<string, string>
    // Equality, not "contains". `server` importing `game` or `render` is a
    // server that pulls `three` and fails to start on a headless box, and it is
    // the arrow spec §3 fixes.
    expect(Object.keys(deps).sort()).toEqual(
      ['@tapkart/content', '@tapkart/net', '@tapkart/protocol', '@tapkart/sim', 'ws'].sort(),
    )
    expect(deps['@tapkart/game']).toBeUndefined()
    expect(deps['@tapkart/render']).toBeUndefined()
    expect(deps.three).toBeUndefined()
  })

  it('pins ws exactly, with no range operator anywhere in it', () => {
    // "<pinned exactly, no caret>" (§10.1). A caret on the one third-party
    // runtime dependency in the image means the deployed bytes are whatever the
    // registry served that morning, which is not a deploy anybody can reproduce.
    const pkg = readJson(join(PKG_ROOT, 'package.json'))
    const deps = pkg.dependencies as Record<string, string>
    const dev = pkg.devDependencies as Record<string, string>
    expect(deps.ws, 'ws is not pinned to an exact version').toMatch(/^\d+\.\d+\.\d+$/)
    expect(dev['@types/ws'], '@types/ws is not pinned to an exact version').toMatch(/^\d+\.\d+\.\d+$/)
    // @types/ws is a devDependency and therefore never ships (§10.1).
    expect(deps['@types/ws']).toBeUndefined()
  })

  it('has a DOM-free tsconfig, and so does every package server imports', () => {
    const own = readJson(join(PKG_ROOT, 'tsconfig.json'))
    expect(own.extends).toBe('../../tsconfig.base.json')
    expect(own.include).toEqual(['src/**/*.ts', 'test/**/*.ts'])
    // No `compilerOptions` at all: R35 keeps DOM out of the four packages
    // `server` imports, and `server` itself has no use for it. A `lib` override
    // here is the one edit that would silently make a DOM type compile inside a
    // headless process.
    expect(own.compilerOptions).toBeUndefined()

    const base = readJson(join(REPO_ROOT, 'tsconfig.base.json'))
    const baseOpts = base.compilerOptions as Record<string, unknown>
    expect(baseOpts.lib).toEqual(['ES2022'])

    for (const p of ['sim', 'protocol', 'net', 'content', 'server']) {
      const cfg = readJson(join(REPO_ROOT, 'packages', p, 'tsconfig.json'))
      const opts = (cfg.compilerOptions ?? {}) as Record<string, unknown>
      expect(opts.lib, `packages/${p} widened lib; server's import closure must stay DOM-free`)
        .toBeUndefined()
    }
  })
})

describe('the Plan 2 + Plan 3 gate, at runtime', () => {
  const makeContext = (): SimContext => {
    const loaded = loadTrack(TRACK_MANIFEST[0].id)
    return {
      track: loaded.track,
      query: loaded.query,
      tuning: TUNING,
      characters: [...CHARACTERS],
      isLeader: false,
    }
  }

  it('composes content + sim + net into a ShadowLoop in one process', () => {
    const ctx = makeContext()
    const state = createState(ctx, 1, new Array<number>(MAX_KARTS).fill(0))
    const shadow = new ShadowLoop(ctx, state, createNullTransport())
    // G3, at runtime: -1 until promoted. `RaceRuntime` bookkeeping, one log line
    // and `seatMapOf`'s `isAuthority` all read it.
    expect(promotionTickOf(shadow)).toBe(-1)
    // §7.1: ShadowLoop does NOT copy its ctx, so constructing one must not have
    // flipped the caller's isLeader. A memoised contextFor would make one room's
    // promotion turn every room into a leader.
    expect(ctx.isLeader).toBe(false)
  })

  it('carries the six tracks and a non-empty character table', () => {
    expect(TRACK_MANIFEST).toHaveLength(6)
    expect(CHARACTERS.length).toBeGreaterThan(0)
    expect(new Set(TRACK_MANIFEST.map((t) => t.id)).size).toBe(6)
  })

  it('holds the four constants every later task reads, at their contract values', () => {
    // 5, not 8: two copies of a catch-up constant drift, and spec §11 names
    // catch-up as a top risk (F-P4-7).
    expect(MAX_CATCHUP_TICKS).toBe(5)
    // Milliseconds, not the 90 ticks it was before Task 15c item C (F-P4-22).
    expect(HOST_TIMEOUT_MS).toBe(1500)
    // FIVE characters (F-P4-34), and Crockford's alphabet - which KEEPS 0 and 1
    // and drops I, L, O and U. Three drafts proposed three alphabets; only this
    // one is on the wire, and its ORDER is the 5-bit index.
    expect(ROOM_CODE_LENGTH).toBe(5)
    expect(ROOM_CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ')
    expect(ROOM_CODE_ALPHABET).toHaveLength(32)
  })

  it('freezes LOBBY_PATH_PREFIX, which the APK compiles into its intent filter', () => {
    // C-1. This string is the APK's `autoVerify` pathPrefix, matched
    // case-sensitively and prefix-exactly, and it is FROZEN AT THE FIRST SIGNED
    // RELEASE. A mismatch between the server's routing and the APK is a SILENT
    // App Links failure: the tap opens a browser instead of the app, with no
    // error anywhere. One constant, read by everything.
    expect(LOBBY_PATH_PREFIX).toBe('/r/')
    expect(lobbyPathFor('0ABCD')).toBe('/r/0ABCD')
    // Built from the constant, so the two can never disagree.
    expect(lobbyPathFor('0ABCD').startsWith(LOBBY_PATH_PREFIX)).toBe(true)
    // No host anywhere: the server answers with PATHS and the client builds the
    // absolute URL from its own origin (C-3, contract §0).
    expect(LOBBY_PATH_PREFIX).not.toMatch(/:\/\//)
  })
})
