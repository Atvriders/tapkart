import { readFileSync } from 'node:fs'
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
      port: 3031,
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
    expect(() => parseConfig({ TAPKART_ORIGIN: 'https://tapkart.example' })).toThrow(/TAPKART_ORIGIN/)
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
