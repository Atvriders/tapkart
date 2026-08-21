import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ASSETLINKS_ENV_VARS } from '@tapkart/invite'
import { ENV_SCHEMA, type EnvVarSpec } from '@tapkart/server'

const REPO_ROOT = new URL('../../../', import.meta.url)
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, REPO_ROOT)), 'utf8')

const DOCKERFILE = read('Dockerfile')
const COMPOSE = read('compose.yaml')
const README = read('README.md')
const ROOT_PKG = JSON.parse(read('package.json')) as { scripts: Record<string, string> }

/** ENV_SCHEMA ∪ ASSETLINKS_ENV_VARS — §11.2: the deployment's variables are
 * exactly this union, and nothing else may appear in either file. */
const KNOWN = new Map<string, EnvVarSpec | null>([
  ...ENV_SCHEMA.map((spec) => [spec.name, spec] as const),
  ...ASSETLINKS_ENV_VARS.map((name) => [name, null] as const),
])

/** `ENV NAME=value` and `ENV NAME value`, one per line. */
function dockerfileEnvNames(text: string): string[] {
  const names: string[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*ENV\s+([A-Za-z_][A-Za-z0-9_]*)\s*[= ]/.exec(line)
    if (match !== null) names.push(match[1])
  }
  return names
}

interface ComposeVar {
  name: string
  value: string
  commented: boolean
}

/** The one service's `environment:` block, including commented-out rows. */
function composeEnvironment(text: string): ComposeVar[] {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^\s*environment:\s*$/.test(line))
  if (start < 0) throw new Error('compose.yaml has no `environment:` block')
  const indent = (lines[start].match(/^\s*/) ?? [''])[0].length

  const out: ComposeVar[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const lead = (line.match(/^\s*/) ?? [''])[0].length
    const body = line.trim()
    if (lead <= indent && !body.startsWith('#')) break
    const match = /^#?\s*([A-Z_][A-Z0-9_]*)\s*:\s*(.*)$/.exec(body)
    if (match === null) continue
    const raw = match[2].trim()
    const value = raw
      .replace(/\s+#.*$/, '')
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1')
    out.push({ name: match[1], value, commented: body.startsWith('#') })
  }
  if (out.length === 0) {
    throw new Error('compose.yaml `environment:` block parsed to zero variables')
  }
  return out
}

describe('the deployment files name exactly ENV_SCHEMA ∪ ASSETLINKS_ENV_VARS (C-6)', () => {
  it('reads both files and finds something in each', () => {
    expect(DOCKERFILE.length).toBeGreaterThan(200)
    expect(COMPOSE.length).toBeGreaterThan(200)
    expect(KNOWN.size).toBeGreaterThan(ASSETLINKS_ENV_VARS.length)
    expect(composeEnvironment(COMPOSE).length).toBeGreaterThan(0)
  })

  it('rule 1: every ENV line in the Dockerfile names a variable in the union', () => {
    const unknown = dockerfileEnvNames(DOCKERFILE).filter((name) => !KNOWN.has(name))
    expect(unknown).toEqual([])
  })

  it('rule 2: every compose variable, including comments, is in the union', () => {
    const unknown = composeEnvironment(COMPOSE)
      .map((entry) => entry.name)
      .filter((name) => !KNOWN.has(name))
    expect(unknown).toEqual([])
  })

  it('rule 3: every commented row carries the schema default exactly', () => {
    const wrong: string[] = []
    for (const entry of composeEnvironment(COMPOSE)) {
      if (!entry.commented) continue
      const spec = KNOWN.get(entry.name)
      if (spec === null || spec === undefined) continue
      if (spec.defaultValue !== entry.value) {
        wrong.push(
          `${entry.name}: compose says "${entry.value}", ENV_SCHEMA says "${spec.defaultValue}"`,
        )
      }
    }
    expect(wrong).toEqual([])
  })

  it('rule 4: every required variable appears uncommented', () => {
    const live = new Set(
      composeEnvironment(COMPOSE)
        .filter((entry) => !entry.commented)
        .map((entry) => entry.name),
    )
    const missing = ENV_SCHEMA
      .filter((spec) => spec.required && !live.has(spec.name))
      .map((spec) => spec.name)
    expect(missing).toEqual([])
  })

  it('rule 5: every variable in the union appears in at least one deployment file', () => {
    const declared = new Set([
      ...dockerfileEnvNames(DOCKERFILE),
      ...composeEnvironment(COMPOSE).map((entry) => entry.name),
    ])
    const missing = [...KNOWN.keys()].filter((name) => !declared.has(name))
    expect(missing).toEqual([])
  })

  it('sets both App Links variables live with safe empty defaults', () => {
    const compose = composeEnvironment(COMPOSE)
    for (const name of ASSETLINKS_ENV_VARS) {
      const entry = compose.find((candidate) => candidate.name === name)
      expect(entry?.commented, name).toBe(false)
      expect(entry?.value, name).toBe(`\${${name}:-}`)
    }
    expect(COMPOSE).not.toContain('DE:AD:BE:EF')
  })
})

describe('L3: no TAPKART_ variable reaches a server that would reject it', () => {
  it('every TAPKART_ variable in either file is in ENV_SCHEMA', () => {
    const schemaNames = new Set(ENV_SCHEMA.map((spec) => spec.name))
    const named = [
      ...dockerfileEnvNames(DOCKERFILE),
      ...composeEnvironment(COMPOSE).map((entry) => entry.name),
    ].filter((name) => name.startsWith('TAPKART_'))
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((name) => !schemaNames.has(name))).toEqual([])
  })

  it('neither file mentions a signing-build variable', () => {
    for (const text of [DOCKERFILE, COMPOSE]) {
      expect(text).not.toMatch(/TAPKART_KEYSTORE_/)
      expect(text).not.toMatch(/TAPKART_KEY_/)
    }
  })

  it('neither file sets TAPKART_ORIGIN', () => {
    for (const text of [DOCKERFILE, COMPOSE]) {
      expect(text).not.toMatch(/^\s*#?\s*(ENV\s+)?TAPKART_ORIGIN\b/m)
    }
  })
})

/**
 * STATIC_ROOT defaults to the RELATIVE path `apps/web/dist`, resolved against the
 * process's working directory. That makes the server's ability to serve the game
 * a property of where it was launched from, and `npm run -w <pkg>` relocates the
 * working directory into the package.
 *
 * So `npm run start -w @tapkart/server` -- which the README printed for the whole
 * of Plan 5 -- resolved STATIC_ROOT to `packages/server/apps/web/dist`, which does
 * not exist. `/` returned 404 while `/healthz` returned 200, so the failure read
 * as a bad build rather than a bad instruction, and nothing in the suite noticed:
 * every path that actually works pins the root explicitly (the e2e lane runs the
 * bundle from the repository root, and the image sets an absolute STATIC_ROOT
 * under WORKDIR /app).
 *
 * The root `start` script is the fix -- `npm run` at the root leaves the working
 * directory at the root -- and this gate is what stops the README drifting back
 * to a per-package invocation that silently serves nothing.
 */
describe('the documented local run command resolves STATIC_ROOT', () => {
  it('runs the server bundle from the repository root', () => {
    const start = ROOT_PKG.scripts.start
    expect(start, 'the root package.json needs a `start` script').toBeDefined()
    expect(start).toBe('node packages/server/dist/main.mjs')
  })

  it('the default STATIC_ROOT is relative, which is why the root matters', () => {
    const spec = ENV_SCHEMA.find((entry) => entry.name === 'STATIC_ROOT')
    expect(spec?.defaultValue).toBe('apps/web/dist')
    expect(spec!.defaultValue!.startsWith('/')).toBe(false)
  })

  it("the README's run block invokes that script, never a per-package one", () => {
    const block = /```bash\nnpm run build:server\n([^\n]+)\n```/.exec(README)
    expect(block, "README has no `npm run build:server` run block").not.toBeNull()
    expect(block![1]).toBe('npm start')
    expect(README).not.toMatch(/npm run start -w/)
  })
})

describe('the image is wired the way §11.1 fixes it', () => {
  it('uses Node 22, builds in order, and sets an absolute STATIC_ROOT', () => {
    expect(DOCKERFILE.match(/^FROM (?:--platform=\$BUILDPLATFORM )?node:22-alpine/gm)).toHaveLength(2)
    const install = DOCKERFILE.indexOf('RUN npm ci')
    const web = DOCKERFILE.indexOf('RUN npm run build -w @tapkart/web')
    const server = DOCKERFILE.indexOf('RUN npm run build -w @tapkart/server')
    const assetlinks = DOCKERFILE.indexOf('npm exec -- esbuild apps/web/tools/write-assetlinks.ts')
    expect(install).toBeGreaterThan(-1)
    expect(web).toBeGreaterThan(install)
    expect(server).toBeGreaterThan(web)
    expect(assetlinks).toBeGreaterThan(server)
    expect(DOCKERFILE).not.toMatch(/\bnpx\s+esbuild\b/)
    const match = /^\s*ENV\s+STATIC_ROOT\s*[= ]\s*"?([^"\s]+)"?/m.exec(DOCKERFILE)
    expect(match).not.toBeNull()
    expect(match![1].startsWith('/')).toBe(true)
  })

  it('binds 0.0.0.0 and never a real hostname', () => {
    expect(DOCKERFILE).toMatch(/^\s*ENV\s+BIND_HOST\s*[= ]\s*"?0\.0\.0\.0"?/m)
  })

  it('runs as the non-root node user', () => {
    expect(DOCKERFILE).toMatch(/^\s*USER\s+node\s*$/m)
  })

  it('exposes and health-checks the schema port', () => {
    const port = ENV_SCHEMA.find((spec) => spec.name === 'PORT')?.defaultValue
    expect(port).not.toBeNull()
    expect(DOCKERFILE).toContain(`EXPOSE ${port}`)
    expect(DOCKERFILE).toContain(`process.env.PORT||'${port}'`)
    expect(DOCKERFILE).toContain("'http://127.0.0.1:'+p+'/healthz'")
  })

  it('passes and publishes the same configurable schema port in compose', () => {
    const port = ENV_SCHEMA.find((spec) => spec.name === 'PORT')?.defaultValue
    const interpolation = `\${PORT:-${port}}`
    expect(COMPOSE).toContain(`"${interpolation}:${interpolation}"`)
    const configured = composeEnvironment(COMPOSE).find((entry) => entry.name === 'PORT')
    expect(configured).toEqual({ name: 'PORT', value: interpolation, commented: false })
  })

  it('does not advertise disabling the required v1 shadow authority', () => {
    expect(COMPOSE).not.toMatch(/^\s*#\s*SHADOW_ENABLED\s*:/m)
  })

  /**
   * The build stage is pinned to the BUILDER's architecture and the runtime
   * stage is not, and the asymmetry is the whole point.
   *
   * Pin neither, and buildx runs the entire npm workspace build under QEMU to
   * produce the arm64 leg. That is not hypothetical: this repository's first
   * multi-architecture build spent over ninety minutes emulating a build whose
   * every output -- bundled ESM and static assets -- is byte-identical across
   * architectures.
   *
   * Pin BOTH, and the failure is silent and much worse: the runtime stage is
   * where the per-architecture `node` binary comes from, so an amd64 runtime
   * would be published under the arm64 tag and every arm64 host would pull an
   * image that cannot exec its own entrypoint. Nothing in CI would notice,
   * because CI is amd64.
   */
  it('builds on the builder architecture and runs on the target one', () => {
    const stages = [...DOCKERFILE.matchAll(/^FROM\s+(.*?)\s+AS\s+(\w+)\s*$/gm)]
    expect(stages.map((m) => m[2])).toEqual(['build', 'runtime'])
    const [build, runtime] = stages
    expect(build[1]).toContain('--platform=$BUILDPLATFORM')
    expect(runtime[1]).not.toContain('--platform')
  })

  /**
   * The corollary the pin depends on: nothing architecture-specific may be
   * carried out of the build stage. Every `COPY --from=build` must name
   * bundled JavaScript or static assets. The moment someone copies out
   * `node_modules` -- which holds native `.node` binaries for the BUILDER --
   * the pin above starts shipping amd64 code inside the arm64 image.
   */
  it('carries nothing architecture-specific out of the build stage', () => {
    const copies = [...DOCKERFILE.matchAll(/^COPY --from=build\s+(?:--chown=\S+\s+)?(\S+)/gm)]
    expect(copies.length).toBeGreaterThan(0)
    for (const [, source] of copies) {
      expect(source, `${source} is copied out of the build stage`).not.toMatch(/node_modules/)
      expect(source).toMatch(/\.mjs$|\/dist$/)
    }
  })

  /**
   * F-P5-33 makes `latest` mean a release, so that is what compose must default
   * to. The tag stays overridable because a release is the one thing this
   * repository cannot produce for itself -- it needs the owner's signing
   * keystore -- and until the first `v*` tag exists, an un-overridable `latest`
   * makes the README's own quickstart fail on a manifest that was never
   * published. The default is still `latest`, and is asserted as such: `edge`
   * is what a self-hoster opts into, never what they get by accident.
   */
  /**
   * The label that links the published package to this repository.
   *
   * Its absence is silent and easy to misread as a failed publish: the image
   * still builds, still pushes, and still pulls anonymously, but GitHub shows
   * nothing under Packages on the repository page, so the only ways to reach it
   * are its direct URL or a search of the account's package list. That is
   * exactly how this image looked missing after it had in fact been published.
   *
   * It lives in the runtime stage because that is the stage that becomes the
   * published image -- a label on the build stage is discarded with it -- and in
   * the Dockerfile rather than in a workflow input so that every build path
   * carries it, including a local `docker build` and the release workflow, which
   * is a second `build-push-action` that would otherwise need the same fix again.
   */
  it('labels the image with the repository that publishes it', () => {
    const runtime = DOCKERFILE.slice(DOCKERFILE.indexOf('AS runtime'))
    const source = /org\.opencontainers\.image\.source="([^"]+)"/.exec(runtime)
    expect(source, 'the runtime stage carries no image.source label').not.toBeNull()
    expect(source![1]).toBe('https://github.com/Atvriders/tapkart')
    // The compose file pulls from the same account/name the label points at.
    const image = /image:\s*ghcr\.io\/([^:\s]+)/.exec(COMPOSE)
    expect(image![1]).toBe(source![1].replace('https://github.com/', '').toLowerCase())
  })

  it('defaults to latest and lets a self-hoster override the tag', () => {
    const match = /image:\s*ghcr\.io\/atvriders\/tapkart:(\S+)/.exec(COMPOSE)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('${TAG:-latest}')
  })
})
