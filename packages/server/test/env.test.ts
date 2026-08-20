import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ICE_SERVERS } from '@tapkart/net'
import { MAX_KARTS } from '@tapkart/sim'
import type { EnvVarSpec } from '../src/env'
import { DEFAULT_CONFIG, ENV_SCHEMA, formatEnvTable, parseConfig } from '../src/env'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV_DOC = join(HERE, '..', '..', '..', 'docs', 'server-env.md')

function specOf(name: string): EnvVarSpec {
  const spec = ENV_SCHEMA.find((candidate) => candidate.name === name)
  if (spec === undefined) throw new Error(`ENV_SCHEMA has no ${name}`)
  return spec
}

describe('ENV_SCHEMA', () => {
  it('names every variable exactly once', () => {
    const names = ENV_SCHEMA.map((spec) => spec.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('declares the twelve supported variables in stable order', () => {
    expect(ENV_SCHEMA.map((spec) => spec.name)).toEqual([
      'PORT', 'BIND_HOST', 'STATIC_ROOT', 'MAX_ROOMS', 'MAX_PEERS_PER_ROOM',
      'ROOM_IDLE_MS', 'JOIN_RATE_WINDOW_MS', 'JOIN_RATE_MAX', 'ICE_SERVERS',
      'SHADOW_ENABLED', 'TAPKART_ANDROID_PACKAGE', 'TAPKART_SHA256_FINGERPRINTS',
    ])
  })

  it('gives optional variables parseable defaults and descriptions', () => {
    for (const spec of ENV_SCHEMA) {
      expect(spec.required).toBe(false)
      expect(typeof spec.defaultValue).toBe('string')
      expect(spec.description.length).toBeGreaterThan(0)
      expect(() => parseConfig({ [spec.name]: spec.defaultValue ?? '' })).not.toThrow()
    }
  })

  it('keeps the default static path relative and checkout-local', () => {
    const value = specOf('STATIC_ROOT').defaultValue ?? ''
    expect(value).toBe('apps/web/dist')
    expect(value).not.toMatch(/^(?:\/|[A-Za-z]:|\.\.)/)
  })

  it('contains no private-network host in a default', () => {
    for (const spec of ENV_SCHEMA) {
      expect(spec.defaultValue ?? '').not.toMatch(/\b(?:10\.\d+|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./)
    }
  })
})

describe('parseConfig defaults and overrides', () => {
  it('is the single source of DEFAULT_CONFIG', () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG)
  })

  it('matches the pinned production defaults', () => {
    expect(parseConfig({})).toEqual({
      port: 3037,
      bindHost: '0.0.0.0',
      staticRoot: 'apps/web/dist',
      maxRooms: 64,
      maxPeersPerRoom: MAX_KARTS,
      roomIdleMs: 600_000,
      joinRateLimit: { windowMs: 60_000, max: 10 },
      iceServers: DEFAULT_ICE_SERVERS,
      shadowEnabled: true,
    })
  })

  it('ignores environment variables outside its namespace', () => {
    expect(parseConfig({ PATH: '/usr/bin', NODE_ENV: 'production' })).toEqual(DEFAULT_CONFIG)
  })

  it('reads every supported server override', () => {
    expect(parseConfig({
      PORT: '8080', BIND_HOST: '127.0.0.1', STATIC_ROOT: '/app/web',
      MAX_ROOMS: '4', MAX_PEERS_PER_ROOM: '2', ROOM_IDLE_MS: '1000',
      JOIN_RATE_WINDOW_MS: '5000', JOIN_RATE_MAX: '3',
      ICE_SERVERS: 'stun:stun.example:3478,turns:relay.example:5349',
      SHADOW_ENABLED: 'true',
    })).toEqual({
      port: 8080,
      bindHost: '127.0.0.1',
      staticRoot: '/app/web',
      maxRooms: 4,
      maxPeersPerRoom: 2,
      roomIdleMs: 1000,
      joinRateLimit: { windowMs: 5000, max: 3 },
      iceServers: [
        { urls: ['stun:stun.example:3478'] },
        { urls: ['turns:relay.example:5349'] },
      ],
      shadowEnabled: true,
    })
  })

  it('treats an empty ICE_SERVERS value as no servers', () => {
    expect(parseConfig({ ICE_SERVERS: '' }).iceServers).toEqual([])
  })

  it('permits an ephemeral port and refuses one beyond 65535', () => {
    expect(parseConfig({ PORT: '0' }).port).toBe(0)
    expect(() => parseConfig({ PORT: '65536' })).toThrow(/PORT/)
  })

  it.each(['lots', '12.5', '-1', ''])('refuses malformed numbers (%s)', (value) => {
    expect(() => parseConfig({ MAX_ROOMS: value })).toThrow(/MAX_ROOMS/)
  })

  it.each(['1', 'yes', 'TRUE', ''])('refuses ambiguous booleans (%s)', (value) => {
    expect(() => parseConfig({ SHADOW_ENABLED: value })).toThrow(/SHADOW_ENABLED/)
  })

  it('rejects disabling the v1 host-loss authority instead of accepting a broken mode', () => {
    expect(() => parseConfig({ SHADOW_ENABLED: 'false' })).toThrow(
      /SHADOW_ENABLED: false is unsupported in TapKart v1; shadow authority is required/,
    )
  })

  it('refuses unknown TAPKART variables by their own name', () => {
    expect(() => parseConfig({ TAPKART_SHADOW_ENABLED: 'true' })).toThrow(/TAPKART_SHADOW_ENABLED/)
    expect(() => parseConfig({ TAPKART_MAX_ROMS: '64' })).toThrow(/TAPKART_MAX_ROMS/)
    // ...but a build-time sibling is ignored, not fatal: the server must boot
    // with the build environment it is legitimately handed.
    expect(() => parseConfig({ TAPKART_ORIGIN: 'https://tapkart.example' })).not.toThrow()
    expect(() => parseConfig({ TAPKART_KEYSTORE_PASSWORD: 'hunter2' })).not.toThrow()
  })

  it('accepts but does not consume the two entrypoint variables', () => {
    expect(parseConfig({
      TAPKART_ANDROID_PACKAGE: 'com.example.tapkart',
      TAPKART_SHA256_FINGERPRINTS: 'DE:AD',
    })).toEqual(DEFAULT_CONFIG)
  })
})

describe('formatEnvTable', () => {
  it('renders one Markdown row per schema entry', () => {
    const lines = formatEnvTable().split('\n')
    expect(lines[0]).toBe('| Variable | Type | Required | Default | Description |')
    expect(lines).toHaveLength(ENV_SCHEMA.length + 2)
  })

  it('is embedded byte-for-byte in the checked-in documentation', () => {
    expect(readFileSync(ENV_DOC, 'utf8')).toContain(formatEnvTable())
  })

  it('discloses the default third-party STUN endpoint and its opt-out', () => {
    const doc = readFileSync(ENV_DOC, 'utf8')
    expect(doc).toContain('stun:stun.l.google.com:19302')
    expect(doc).toMatch(/third-party/i)
    expect(doc).toContain('ICE_SERVERS=')
  })

  it('names no private-network address', () => {
    expect(readFileSync(ENV_DOC, 'utf8')).not.toMatch(/\b(?:10\.\d+|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./)
  })
})

/**
 * C-6: `env.ts` is the single source of truth for configuration, and the files
 * that set it must be checked against it.
 *
 * The doc was already checked above. The compose file was not, and nothing in
 * the repository referenced it — which matters more than it sounds, because
 * `parseConfig` THROWS on an unknown `TAPKART_*` variable (env.ts:128). A
 * compose file that sets a variable the schema does not declare does not
 * misconfigure the server; it stops the container booting at all. That exact
 * failure was found once by cross-reading two contract drafts, fixed, and then
 * left with no guard against recurring.
 */
describe('C-6: compose.yaml agrees with ENV_SCHEMA', () => {
  const COMPOSE = join(HERE, '..', '..', '..', 'compose.yaml')
  const compose = (): string => readFileSync(COMPOSE, 'utf8')

  /** Every `KEY: "..."` under the service's `environment:` block, commented or not. */
  function composeEnvKeys(text: string): { live: string[]; commented: string[] } {
    const lines = text.split('\n')
    const start = lines.findIndex((l) => /^\s*environment:\s*$/.test(l))
    expect(start).toBeGreaterThanOrEqual(0)
    const live: string[] = []
    const commented: string[] = []
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s{0,4}\S/.test(line) && !/^\s*#/.test(line)) break // dedent ends the block
      const live_m = /^\s+([A-Z][A-Z0-9_]*):\s/.exec(line)
      if (live_m !== null) { live.push(live_m[1]); continue }
      const dead_m = /^\s+#\s*([A-Z][A-Z0-9_]*):\s/.exec(line)
      if (dead_m !== null) commented.push(dead_m[1])
    }
    return { live, commented }
  }

  it('sets no variable the schema does not declare', () => {
    const { live, commented } = composeEnvKeys(compose())
    const declared = new Set(ENV_SCHEMA.map((s) => s.name))
    // Non-vacuity: the block must actually have been found and parsed.
    expect(live.length).toBeGreaterThan(0)
    expect(commented.length).toBeGreaterThan(0)
    expect([...live, ...commented].filter((k) => !declared.has(k))).toEqual([])
  })

  it('boots: parseConfig accepts exactly the environment compose produces', () => {
    const { live } = composeEnvKeys(compose())
    // Compose substitutes `${VAR:-default}`; an unset host env yields the default,
    // and for the two APK variables that default is the empty string.
    const env: Record<string, string> = {}
    for (const key of live) env[key] = key === 'PORT' ? '3037' : ''
    expect(() => parseConfig(env)).not.toThrow()
  })

  it('carries a generated-defaults block that matches the schema, in order', () => {
    const text = compose()
    const block = /# BEGIN GENERATED DEFAULTS[^\n]*\n([\s\S]*?)\s*# END GENERATED DEFAULTS/.exec(text)
    expect(block).not.toBeNull()
    const rows = (block as RegExpExecArray)[1]
      .split('\n')
      .map((l) => /^\s*#\s*([A-Z][A-Z0-9_]*):\s*"(.*)"\s*$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1], m[2]] as const)

    // Every row is a real schema entry carrying that entry's real default.
    expect(rows.length).toBeGreaterThan(0)
    for (const [name, value] of rows) expect(specOf(name).defaultValue).toBe(value)

    // And the block's order follows ENV_SCHEMA's, so a reordered schema is visible.
    const order = ENV_SCHEMA.map((s) => s.name)
    const idx = rows.map(([name]) => order.indexOf(name))
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
  })

  it('names no private-network address', () => {
    expect(compose()).not.toMatch(/\b(?:10\.\d+|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./)
  })
})

/**
 * The workflows are the surface that actually bit. C-6's first pass checked
 * compose.yaml; CI sets TAPKART_ORIGIN workflow-wide, every job inherits it,
 * and the server refused to boot with "unknown TAPKART_ variable" before a
 * single e2e test ran. A gate that covers one of two places a variable can be
 * set is not a gate.
 */
describe('C-6: the CI workflows set no TAPKART_ variable the server would reject', () => {
  const WORKFLOWS = join(HERE, '..', '..', '..', '.github', 'workflows')

  function workflowFiles(): string[] {
    return readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  }

  it('finds the workflows at all', () => {
    expect(workflowFiles().length).toBeGreaterThan(0)
  })

  it.each(['ci.yml', 'release.yml'])('%s sets only variables the server tolerates', (file) => {
    const text = readFileSync(join(WORKFLOWS, file), 'utf8')
    // Every `TAPKART_FOO:` assignment, anywhere in the file, at any nesting.
    const assigned = [...text.matchAll(/^\s*(TAPKART_[A-Z0-9_]+):/gm)].map((m) => m[1])
    expect(assigned.length).toBeGreaterThan(0)

    // Tolerated means: parseConfig does not throw when it is present.
    for (const name of new Set(assigned)) {
      expect(
        () => parseConfig({ [name]: '' }),
        `${file} sets ${name}, which parseConfig rejects — the server will not boot`,
      ).not.toThrow()
    }
  })
})
