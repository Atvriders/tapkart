// PURE. The process environment is passed in; this module performs no I/O.
import type { IceServerConfig } from '@tapkart/net'
import { DEFAULT_ICE_SERVERS } from '@tapkart/net'
import { MAX_KARTS } from '@tapkart/sim'

export interface EnvVarSpec {
  name: string
  kind: 'number' | 'string' | 'boolean' | 'csv'
  required: boolean
  defaultValue: string | null
  description: string
}

const TAPKART_PREFIX = 'TAPKART_'
const DEFAULT_ICE_URLS = DEFAULT_ICE_SERVERS.flatMap((server) => server.urls).join(',')

/** The sole declaration of every environment variable accepted by the image. */
export const ENV_SCHEMA: readonly EnvVarSpec[] = [
  {
    name: 'PORT', kind: 'number', required: false, defaultValue: '3037',
    description: 'The port the HTTP and WebSocket server binds. Spec §9.',
  },
  {
    name: 'BIND_HOST', kind: 'string', required: false, defaultValue: '0.0.0.0',
    description: 'The address to bind. A wildcard, never a real hostname.',
  },
  {
    name: 'STATIC_ROOT', kind: 'string', required: false, defaultValue: 'apps/web/dist',
    description: 'The web build to serve, relative to the working directory. `<STATIC_ROOT>/.well-known/` is the one well-known directory.',
  },
  {
    name: 'MAX_ROOMS', kind: 'number', required: false, defaultValue: '64',
    description: 'Rooms per process. At the cap a create is refused rather than a live race evicted.',
  },
  {
    name: 'MAX_PEERS_PER_ROOM', kind: 'number', required: false, defaultValue: String(MAX_KARTS),
    description: 'Peers per room. The ninth joiner is refused with `roomFull`; there are no spectators.',
  },
  {
    name: 'ROOM_IDLE_MS', kind: 'number', required: false, defaultValue: '600000',
    description: 'How long a room may sit idle before it is closed.',
  },
  {
    name: 'JOIN_RATE_WINDOW_MS', kind: 'number', required: false, defaultValue: '60000',
    description: 'The failed-join window, counted per ROOM CODE and never per IP.',
  },
  {
    name: 'JOIN_RATE_MAX', kind: 'number', required: false, defaultValue: '10',
    description: 'Failed joins allowed per room code per window. A successful join costs nothing.',
  },
  {
    name: 'ICE_SERVERS', kind: 'csv', required: false, defaultValue: DEFAULT_ICE_URLS,
    description: 'Comma-separated ICE URLs. The default is a third-party endpoint contacted at connection time; set it empty to use none.',
  },
  {
    name: 'SHADOW_ENABLED', kind: 'boolean', required: false, defaultValue: 'true',
    description: 'Compatibility guard fixed to true in v1; false is rejected because host-loss recovery requires shadow authority.',
  },
  {
    name: 'TAPKART_ANDROID_PACKAGE', kind: 'string', required: false, defaultValue: '',
    description: "Read by the container entrypoint's assetlinks generator, never by the server.",
  },
  {
    name: 'TAPKART_SHA256_FINGERPRINTS', kind: 'csv', required: false, defaultValue: '',
    description: 'Comma-separated signing-certificate fingerprints, read by the same generator and never by the server.',
  },
]

export interface RateLimitConfig {
  windowMs: number
  max: number
}

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

const KNOWN_NAMES: ReadonlySet<string> = new Set(ENV_SCHEMA.map((spec) => spec.name))

function specOf(name: string): EnvVarSpec {
  const spec = ENV_SCHEMA.find((candidate) => candidate.name === name)
  if (spec === undefined) throw new Error(`env: ${name} is not in ENV_SCHEMA`)
  return spec
}

function rawOf(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const spec = specOf(name)
  const value = env[name]
  if (value !== undefined) return value
  if (spec.defaultValue === null) throw new Error(`${name}: required and not set`)
  return spec.defaultValue
}

function numberOf(env: Readonly<Record<string, string | undefined>>, name: string): number {
  const raw = rawOf(env, name).trim()
  if (!/^-?\d+$/.test(raw)) throw new Error(`${name}: expected an integer, got "${raw}"`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name}: expected a non-negative integer, got "${raw}"`)
  }
  return value
}

function booleanOf(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const raw = rawOf(env, name).trim()
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name}: expected "true" or "false", got "${raw}"`)
}

function csvOf(env: Readonly<Record<string, string | undefined>>, name: string): string[] {
  return rawOf(env, name).split(',').map((part) => part.trim()).filter((part) => part.length > 0)
}

/**
 * `TAPKART_*` variables that belong to the BUILD, not to the server, and which
 * `parseConfig` therefore ignores rather than rejects.
 *
 * `TAPKART_ORIGIN` is build-time by ruling C-3: it is baked into the web bundle
 * as `VITE_TAPKART_ORIGIN` and compiled into the Android intent filter, because
 * an intent filter cannot be reconfigured at runtime. The server never reads it.
 *
 * It is listed here rather than left to the strict allowlist because it is
 * legitimately present in the environment of anyone who builds and then runs —
 * CI sets it workflow-wide, so every job inherits it. Treating a known sibling
 * as a fatal unknown does not catch a typo, it stops the server booting: that
 * is exactly what happened on this repository's first CI run, where the e2e
 * lane died with "TAPKART_ORIGIN: unknown TAPKART_ variable" before a single
 * test ran.
 *
 * The strict allowlist still stands for everything else — a mistyped
 * `TAPKART_MAX_ROMS` is still fatal, which is the case it exists for.
 */
const BUILD_ONLY_NAMES: ReadonlySet<string> = new Set([
  'TAPKART_ORIGIN',
  // The signing variables, for the same reason and a sharper one. Plan 5's own
  // signing task warned that these "must never enter the container, or
  // parseConfig refuses to boot" -- a rule enforced only by job scoping in the
  // release workflow. Tolerating them here removes the hazard instead of
  // documenting it: the server ignores a keystore password rather than dying
  // because one is in the environment, which is the correct response to a
  // credential it has no business reading.
  'TAPKART_KEYSTORE_PATH',
  'TAPKART_KEYSTORE_PASSWORD',
  'TAPKART_KEY_ALIAS',
  'TAPKART_KEY_PASSWORD',
])

export function parseConfig(
  env: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  for (const key of Object.keys(env)) {
    if (key.startsWith(TAPKART_PREFIX) && !KNOWN_NAMES.has(key) && !BUILD_ONLY_NAMES.has(key)) {
      throw new Error(`${key}: unknown ${TAPKART_PREFIX} variable; see docs/server-env.md`)
    }
  }

  const port = numberOf(env, 'PORT')
  if (port > 65_535) throw new Error(`PORT: expected a port in 0..65535, got "${port}"`)
  const shadowEnabled = booleanOf(env, 'SHADOW_ENABLED')
  if (!shadowEnabled) {
    throw new Error('SHADOW_ENABLED: false is unsupported in TapKart v1; shadow authority is required')
  }

  return {
    port,
    bindHost: rawOf(env, 'BIND_HOST'),
    staticRoot: rawOf(env, 'STATIC_ROOT'),
    maxRooms: numberOf(env, 'MAX_ROOMS'),
    maxPeersPerRoom: numberOf(env, 'MAX_PEERS_PER_ROOM'),
    roomIdleMs: numberOf(env, 'ROOM_IDLE_MS'),
    joinRateLimit: {
      windowMs: numberOf(env, 'JOIN_RATE_WINDOW_MS'),
      max: numberOf(env, 'JOIN_RATE_MAX'),
    },
    iceServers: csvOf(env, 'ICE_SERVERS').map((url) => ({ urls: [url] })),
    shadowEnabled,
  }
}

export const DEFAULT_CONFIG: Readonly<ServerConfig> = parseConfig({})

function renderDefault(spec: EnvVarSpec): string {
  if (spec.defaultValue === null) return '—'
  if (spec.defaultValue === '') return '`""`'
  return `\`${spec.defaultValue}\``
}

export function formatEnvTable(): string {
  const lines = [
    '| Variable | Type | Required | Default | Description |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const spec of ENV_SCHEMA) {
    lines.push(
      `| \`${spec.name}\` | ${spec.kind} | ${spec.required ? 'yes' : 'no'} | ${renderDefault(spec)} | ${spec.description} |`,
    )
  }
  return lines.join('\n')
}
