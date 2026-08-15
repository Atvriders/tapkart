### Task 19: the image, the compose file, the `assetlinks.json` generator, and C-6's drift test

**Files:**
- Create: `apps/web/tools/write-assetlinks.ts` — contract §11.3
- Create: `Dockerfile` — contract §11.1
- Create: `.dockerignore`
- Create: `docker/entrypoint.sh` — contract §11.3
- Create: `compose.yaml` — contract §11.1, §11.2
- Test: `apps/web/test/deploy-env.test.ts` — contract §11.4, C-6's drift test
- Modify: `apps/web/package.json` — **dev**Dependency on `@tapkart/server` (§11.4 only)
- Modify: `package.json` (root) — the `build` script (§15.2)
- Modify: `package-lock.json`

**Ordering:** after **Task 7** (`buildAssetLinks`, `validateAssetLinks`, `ASSETLINKS_ENV_VARS`), **Task 14** (which declares `esbuild` as a root devDependency) and **Task 16** (whose build the image runs). It also needs **Plan 4** merged: the image runs `packages/server`'s build script and the drift test imports its `ENV_SCHEMA`.

**Interfaces:**

- **Consumes** — Task 7's App Links module, quoted:

  ```ts
  export const ASSETLINKS_PATH = '/.well-known/assetlinks.json'
  export interface AssetLinksTarget { namespace: 'android_app'; package_name: string; sha256_cert_fingerprints: string[] }
  export interface AssetLinksStatement { relation: string[]; target: AssetLinksTarget }
  /** Splits on commas and whitespace, trims, upper-cases, drops empties.
   *  Throws naming the offending entry if any survivor fails validation. */
  export function parseFingerprintList(raw: string): string[]
  /** One statement, one target, N fingerprints. Throws on an empty list. */
  export function buildAssetLinks(packageName: string, fingerprints: readonly string[]): AssetLinksStatement[]
  /** Returns a list of human-readable problems; `[]` means valid. */
  export function validateAssetLinks(json: unknown): string[]
  export const ASSETLINKS_ENV_VARS: readonly ['TAPKART_ANDROID_PACKAGE', 'TAPKART_SHA256_FINGERPRINTS']
  ```

- **Consumes** — Plan 4's four deploy facts (§2.5), quoted from its **locked** contract:

  ```ts
  export interface EnvVarSpec {
    name: string
    kind: 'number' | 'string' | 'boolean' | 'csv'
    required: boolean
    /** As a string, exactly as it would be written in a compose file. `null`
     *  when required. */
    defaultValue: string | null
    description: string
  }
  export const ENV_SCHEMA: readonly EnvVarSpec[]
  ```

  1. The server is an **esbuild bundle**, built by `packages/server/scripts/build-server.mjs` behind the package's `build` script, producing exactly one ESM file at **`packages/server/dist/main.mjs`**. Plan 4 owns the script; this task's Dockerfile runs it and copies the output.
  2. `ENV_SCHEMA` is exported from the server's barrel as machine-readable data, and Plan 4 §1a permits Plan 5's tests to import it by name.
  3. The static handler serves `/.well-known/assetlinks.json` **with no redirect**, out of `<STATIC_ROOT>/.well-known/` — Plan 4 deleted `WELL_KNOWN_DIR` so *there is exactly one well-known directory and it is derived from `staticRoot`*.
  4. `/healthz` exists and `PORT` defaults to `3031`.

- **Produces** — §16's census: exactly **2** exports from `apps/web/tools/write-assetlinks.ts`.

  ```ts
  export function assetLinksTargetPath(staticRoot: string): string
  export function writeAssetLinks(env: Record<string, string | undefined>): string[]
  ```

  Plus four declaration files (`Dockerfile`, `.dockerignore`, `docker/entrypoint.sh`, `compose.yaml`) which export nothing and are checked structurally.

**L3 — the cross-plan defect this task is one half of, and it would stop the server booting.** Contract §18.1, and it is the third defect of this shape the project has produced:

> Plan 4's `parseConfig` *"throws on an unknown variable with the prefix `TAPKART_`, because that prefix is ours and a typo in it is always a mistake."* Plan 5's `compose.yaml` sets exactly two of them — `TAPKART_ANDROID_PACKAGE` and `TAPKART_SHA256_FINGERPRINTS` — because §11.3's generator reads them from the container environment at start-up. **As both contracts stand, the compose file C-6 exists to keep in step is the one thing that stops the server booting.**

The confirmed fix is Plan 4's: `ENV_SCHEMA` gains both, `required: false`, described as read by the entrypoint rather than by the server. **This task does not make that change** — it is a two-row change in a Plan 4 file. What it does is make the failure land in a build: the drift test below fails if the compose file names a variable `ENV_SCHEMA` does not carry, and Task 20's container job starts the container **with both variables set**.

**The three variables that must NOT appear in these files.** Task 12's hazard, restated because this is the task that would violate it: `TAPKART_KEYSTORE_PATH`, `TAPKART_KEYSTORE_PASSWORD`, `TAPKART_KEY_ALIAS` and `TAPKART_KEY_PASSWORD` are read by **Gradle, on a build machine**. They carry the `TAPKART_` prefix, so **a container that sets any of them is a container whose server refuses to start.** They are in neither `ENV_SCHEMA` nor `ASSETLINKS_ENV_VARS`, and rules 1 and 2 of the drift test are what keeps that true.

**`TAPKART_ORIGIN` is not here either** (C-3, §11.2). It is a **build-time** variable for the APK and nothing else: the server answers with paths, and `assetlinks.json` contains no origin — it is served *at* one. *"A self-hoster serving the PWA rebuilds nothing and configures no origin."*

**Why the file is generated at container start and never committed** (§11.3): committing it is forbidden by §1, and *"committing it with **placeholder** values is worse than either, because it produces a deployment that serves a **valid-looking** `assetlinks.json` naming a fingerprint that signs nothing — spec §2's silent-failure mode with a false trail of evidence beside it."*

**What CI can and cannot prove about the deployment.** §3.2 and §14:

| CI proves | CI cannot prove |
|---|---|
| The container starts with both `TAPKART_*` set, and serves a shape-valid `assetlinks.json` at the right path, with the right content type, with no 3xx (Task 20, assertion 30) | That the origin the owner deploys behind Cloudflare Tunnel is that container. *"The Cloudflare Tunnel config is the owner's and its hostname is not in the repo"* |
| The container starts with **no** `TAPKART_*` and still answers `/healthz` (assertion 31) | That the tunnel, the proxy or a trailing-slash normalisation does not rewrite the well-known path — `docs/owner-verification.md` item 2's `curl -I` |
| The compose file and the Dockerfile name exactly `ENV_SCHEMA ∪ ASSETLINKS_ENV_VARS` (this task) | That the fingerprint in the deployment is the one that signed the installed APK |

---

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/deploy-env.test.ts` — **the second and last test in this repository that reads the repository's own files** (§1; the first is `no-secrets.test.ts`):

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ASSETLINKS_ENV_VARS } from '@tapkart/invite'
import { ENV_SCHEMA, type EnvVarSpec } from '@tapkart/server'

const REPO_ROOT = new URL('../../../', import.meta.url)
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, REPO_ROOT)), 'utf8')

const DOCKERFILE = read('Dockerfile')
const COMPOSE = read('compose.yaml')

/** ENV_SCHEMA ∪ ASSETLINKS_ENV_VARS — §11.2: "The deployment's variables are
 *  exactly" this union, and nothing else may appear in either file. */
const KNOWN = new Map<string, EnvVarSpec | null>([
  ...ENV_SCHEMA.map((spec) => [spec.name, spec] as const),
  ...ASSETLINKS_ENV_VARS.map((name) => [name, null] as const),
])

/** `ENV NAME=value` and `ENV NAME value`, one per line — the two spellings
 *  Docker accepts for a single variable. */
function dockerfileEnvNames(text: string): string[] {
  const names: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*ENV\s+([A-Za-z_][A-Za-z0-9_]*)\s*[= ]/.exec(line)
    if (m !== null) names.push(m[1])
  }
  return names
}

interface ComposeVar {
  name: string
  value: string
  commented: boolean
}

/** The `environment:` block of the one service, INCLUDING its commented-out
 *  rows — §11.4: "which is the half that rots". */
function composeEnvironment(text: string): ComposeVar[] {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^\s*environment:\s*$/.test(l))
  if (start < 0) throw new Error('compose.yaml has no `environment:` block')
  const indent = (lines[start].match(/^\s*/) ?? [''])[0].length

  const out: ComposeVar[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const lead = (line.match(/^\s*/) ?? [''])[0].length
    const body = line.trim()
    // A line at or left of `environment:`'s own indent ends the block — unless
    // it is a comment, which YAML lets sit at any column.
    if (lead <= indent && !body.startsWith('#')) break
    const m = /^#?\s*([A-Z_][A-Z0-9_]*)\s*:\s*(.*)$/.exec(body)
    if (m === null) continue
    const raw = m[2].trim()
    const value = raw.replace(/\s+#.*$/, '').replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    out.push({ name: m[1], value, commented: body.startsWith('#') })
  }
  if (out.length === 0) throw new Error('compose.yaml `environment:` block parsed to zero variables')
  return out
}

describe('the deployment files name exactly ENV_SCHEMA ∪ ASSETLINKS_ENV_VARS (C-6)', () => {
  it('reads both files and finds something in each — a drift test that read nothing proves nothing', () => {
    expect(DOCKERFILE.length).toBeGreaterThan(200)
    expect(COMPOSE.length).toBeGreaterThan(200)
    expect(KNOWN.size).toBeGreaterThan(ASSETLINKS_ENV_VARS.length)
    expect(composeEnvironment(COMPOSE).length).toBeGreaterThan(0)
  })

  it('rule 1: every ENV line in the Dockerfile names a variable in the union', () => {
    const unknown = dockerfileEnvNames(DOCKERFILE).filter((n) => !KNOWN.has(n))
    expect(unknown).toEqual([])
  })

  it('rule 2: every compose variable, including the commented-out ones, is in the union', () => {
    const unknown = composeEnvironment(COMPOSE)
      .map((v) => v.name)
      .filter((n) => !KNOWN.has(n))
    expect(unknown).toEqual([])
  })

  it('rule 3: every commented-out row carries that variable\'s exact defaultValue', () => {
    const wrong: string[] = []
    for (const v of composeEnvironment(COMPOSE)) {
      if (!v.commented) continue
      const spec = KNOWN.get(v.name)
      if (spec === null || spec === undefined) continue // ASSETLINKS_* have no schema default
      if (spec.defaultValue !== v.value) {
        wrong.push(`${v.name}: compose says "${v.value}", ENV_SCHEMA says "${spec.defaultValue}"`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('rule 4: every required variable in the union appears uncommented', () => {
    const live = new Set(composeEnvironment(COMPOSE).filter((v) => !v.commented).map((v) => v.name))
    const missing = ENV_SCHEMA.filter((s) => s.required && !live.has(s.name)).map((s) => s.name)
    expect(missing).toEqual([])
  })

  it('sets both ASSETLINKS_ENV_VARS uncommented, because the generator reads them at container start', () => {
    const live = new Set(composeEnvironment(COMPOSE).filter((v) => !v.commented).map((v) => v.name))
    for (const name of ASSETLINKS_ENV_VARS) {
      expect(live.has(name), name).toBe(true)
    }
  })
})

describe('L3: no TAPKART_ variable reaches the container that the server would reject', () => {
  /** Plan 4's parseConfig throws on an unknown TAPKART_ variable. Both files
   *  below are the container's environment, so every TAPKART_ name in them must
   *  be one ENV_SCHEMA knows — otherwise the compose file C-6 exists to keep in
   *  step is the one thing that stops the server booting. */
  it('every TAPKART_ variable in either file is in ENV_SCHEMA', () => {
    const schemaNames = new Set(ENV_SCHEMA.map((s) => s.name))
    const named = [
      ...dockerfileEnvNames(DOCKERFILE),
      ...composeEnvironment(COMPOSE).map((v) => v.name),
    ].filter((n) => n.startsWith('TAPKART_'))
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((n) => !schemaNames.has(n))).toEqual([])
  })

  /** The four Gradle signing variables are build-machine only (Task 12). A
   *  container that sets one is a container whose server refuses to start. */
  it('neither file mentions a TAPKART_KEYSTORE_ or TAPKART_KEY_ variable at all', () => {
    for (const text of [DOCKERFILE, COMPOSE]) {
      expect(text).not.toMatch(/TAPKART_KEYSTORE_/)
      expect(text).not.toMatch(/TAPKART_KEY_/)
    }
  })

  /** C-3: TAPKART_ORIGIN is a BUILD variable for the APK and nothing else. */
  it('neither file sets TAPKART_ORIGIN', () => {
    for (const text of [DOCKERFILE, COMPOSE]) {
      expect(text).not.toMatch(/^\s*#?\s*(ENV\s+)?TAPKART_ORIGIN\b/m)
    }
  })
})

describe('the image is wired the way §11.1 fixes it', () => {
  it('sets STATIC_ROOT to an absolute path, because the image is not a checkout', () => {
    const m = /^\s*ENV\s+STATIC_ROOT\s*[= ]\s*"?([^"\s]+)"?/m.exec(DOCKERFILE)
    expect(m).not.toBeNull()
    expect(m![1].startsWith('/')).toBe(true)
  })

  it('binds 0.0.0.0 and never a real hostname (§1)', () => {
    expect(DOCKERFILE).toMatch(/^\s*ENV\s+BIND_HOST\s*[= ]\s*"?0\.0\.0\.0"?/m)
  })

  it('runs as the non-root node user', () => {
    expect(DOCKERFILE).toMatch(/^\s*USER\s+node\s*$/m)
  })

  it('exposes and health-checks the same port the schema defaults to', () => {
    const port = ENV_SCHEMA.find((s) => s.name === 'PORT')?.defaultValue
    expect(port).not.toBeNull()
    expect(DOCKERFILE).toContain(`EXPOSE ${port}`)
    expect(DOCKERFILE).toContain(`127.0.0.1:${port}/healthz`)
  })

  it('publishes that port in the compose file', () => {
    const port = ENV_SCHEMA.find((s) => s.name === 'PORT')?.defaultValue
    expect(COMPOSE).toContain(`"${port}:${port}"`)
  })

  it('pulls the `latest` tag, which F-P5-33 makes mean a release', () => {
    expect(COMPOSE).toMatch(/image:\s*ghcr\.io\/atvriders\/tapkart:latest/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/web/test/deploy-env.test.ts`

Expected: **FAIL at load time** — the module throws while reading files that do not exist yet:

```
Error: ENOENT: no such file or directory, open '.../tapkart/Dockerfile'
```

- [ ] **Step 3: Write the implementation**

**3a.** Add the test-only dependency. §11.4: *"`apps/web` gains `@tapkart/server` as a **devDependency** for this, and for nothing else. It is a test-only edge — the same test-only cross-boundary reach Plan 2 §6 and Plan 3 ruling Q34 already permit for fixtures — and `apps/web/src` never imports it, which P4 Q50's import-allowlist test enforces by exempting `test/`."*

```bash
npm pkg set 'devDependencies.@tapkart/server=*' -w @tapkart/web
npm install
```

**3b.** Create `apps/web/tools/write-assetlinks.ts`. It is TypeScript, not `.mjs`, because *"it imports `@tapkart/invite` for real (§11.3) and is therefore TypeScript, in the app's tsconfig (§8.4), and bundled by `esbuild` in the Docker build stage"*:

```ts
// Container entrypoint tool. Runs once, before the server, inside the image.
//
// It imports @tapkart/invite — the real shipped validator, not a
// reimplementation — per the standing rule from Plan 3 ruling Q2: "a gate that
// reimplements validation tests the gate."

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ASSETLINKS_PATH,
  buildAssetLinks,
  parseFingerprintList,
  validateAssetLinks,
} from '@tapkart/invite'

/** `<staticRoot>/.well-known/assetlinks.json`. Derived from STATIC_ROOT, which
 *  is the SAME variable Plan 4's static handler derives its well-known directory
 *  from (C-2) — so the generator and the handler cannot name different places,
 *  which is exactly what the two drafts did. */
export function assetLinksTargetPath(staticRoot: string): string {
  const root = staticRoot.endsWith('/') ? staticRoot.slice(0, -1) : staticRoot
  return `${root}${ASSETLINKS_PATH}`
}

/** Reads TAPKART_ANDROID_PACKAGE, TAPKART_SHA256_FINGERPRINTS and STATIC_ROOT,
 *  builds the statement with buildAssetLinks(), validates it with
 *  validateAssetLinks(), and writes assetLinksTargetPath(STATIC_ROOT).
 *
 *  Returns the list of problems, so a test can call it directly. */
export function writeAssetLinks(env: Record<string, string | undefined>): string[] {
  const packageName = (env.TAPKART_ANDROID_PACKAGE ?? '').trim()
  const rawFingerprints = (env.TAPKART_SHA256_FINGERPRINTS ?? '').trim()

  // Both unset: a self-hoster with no APK gets a working server. One line, exit
  // 0, no file. There is nothing to serve and nothing is wrong.
  if (packageName === '' && rawFingerprints === '') {
    console.log(
      'write-assetlinks: TAPKART_ANDROID_PACKAGE and TAPKART_SHA256_FINGERPRINTS are unset; ' +
        'no assetlinks.json written. Android App Links will not verify for this deployment, ' +
        'which is correct if you are not shipping an APK.',
    )
    return []
  }

  // STATIC_ROOT has NO default here, deliberately: ENV_SCHEMA's default is the
  // relative 'apps/web/dist', which is a checkout path and wrong inside the
  // image, so a silent default would write a correct file into a directory
  // nothing serves.
  const staticRoot = (env.STATIC_ROOT ?? '').trim()
  if (staticRoot === '') {
    throw new Error(
      'write-assetlinks: STATIC_ROOT is unset. It has no default here on purpose — the schema ' +
        "default is the relative 'apps/web/dist', which is a checkout path and wrong inside the " +
        'image, and defaulting to it would write a correct file into a directory nothing serves.',
    )
  }

  const problems: string[] = []
  if (packageName === '') problems.push('TAPKART_ANDROID_PACKAGE is empty but TAPKART_SHA256_FINGERPRINTS is set')
  if (rawFingerprints === '') problems.push('TAPKART_SHA256_FINGERPRINTS is empty but TAPKART_ANDROID_PACKAGE is set')
  if (problems.length > 0) return problems

  let fingerprints: string[]
  try {
    fingerprints = parseFingerprintList(rawFingerprints)
  } catch (err) {
    return [`TAPKART_SHA256_FINGERPRINTS: ${(err as Error).message}`]
  }

  let statement: unknown
  try {
    statement = buildAssetLinks(packageName, fingerprints)
  } catch (err) {
    return [`buildAssetLinks: ${(err as Error).message}`]
  }

  const invalid = validateAssetLinks(statement)
  if (invalid.length > 0) return invalid

  const target = assetLinksTargetPath(staticRoot)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(statement, null, 2)}\n`, 'utf8')
  console.log(`write-assetlinks: wrote ${target} for ${packageName} (${fingerprints.length} fingerprint(s))`)
  return []
}

// The entrypoint runs this file directly. A misconfigured fingerprint fails
// loudly instead of serving a valid-looking statement that signs nothing.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const found = writeAssetLinks(process.env)
  if (found.length > 0) {
    for (const problem of found) console.error(`write-assetlinks: ${problem}`)
    process.exit(1)
  }
}
```

**3c.** Create `.dockerignore`. It is not in §15.1's create list; it is part of this task's Dockerfile deliverable, and it is not optional: a build context carrying `node_modules/` would make `npm ci` non-deterministic, and one carrying `apps/android/app/build/` or `apps/web/dist/` would copy host build output — including the absolute paths Gradle writes — into a public image.

```gitignore
.git
**/node_modules
apps/web/dist
apps/web/.vite
packages/server/dist
apps/android/app/build
apps/android/.gradle
apps/android/app/src/main/assets/public
docs
e2e
```

`apps/android` itself is **not** excluded: `npm ci` refuses to run when a workspace named in the lockfile has no `package.json` in the context. The Capacitor packages it installs cost the build about half a minute and buy a `npm ci` that is identical to the one CI runs everywhere else.

**3d.** Create `Dockerfile` — contract §11.1:

```dockerfile
# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build stage
FROM node:20-alpine AS build
WORKDIR /src

COPY . .

# One install for the whole workspace. `npm ci` and not `npm install`: the
# lockfile is the input, and a build that resolves a different tree than CI did
# is a build nobody can reproduce.
RUN npm ci

# The PWA: Vite, then tools/build-sw.mjs, which is also §12.2's assertions 26
# and 27 and F-P5-26's build-time offline gate.
RUN npm run build -w @tapkart/web

# C-5: the server is ONE esbuild bundle at packages/server/dist/main.mjs. Plan 4
# owns the script; this stage only runs it. No --experimental-strip-types, no
# tsx: shipping an experimental Node flag as the production entry point is a
# liability with no upside.
RUN npm run build -w @tapkart/server

# The entrypoint tool, bundled the same way and for the same reason — it imports
# @tapkart/invite, whose exports point at .ts.
RUN mkdir -p /out && npx esbuild apps/web/tools/write-assetlinks.ts \
      --bundle --platform=node --format=esm --outfile=/out/write-assetlinks.mjs

# -------------------------------------------------------------- runtime stage
FROM node:20-alpine AS runtime
WORKDIR /app

# The bundle is one file with no node_modules beside it, which is the point of
# C-5: the fastest start, and it keeps the repo's "every exports points at .ts"
# arrangement intact everywhere else.
COPY --from=build --chown=node:node /src/packages/server/dist/main.mjs /app/main.mjs
COPY --from=build --chown=node:node /src/apps/web/dist /app/web
COPY --from=build --chown=node:node /out/write-assetlinks.mjs /app/tools/write-assetlinks.mjs
COPY --chown=node:node docker/entrypoint.sh /app/entrypoint.sh

# §11.3 writes here at container start, so it must exist and be writable by the
# user that runs. C-2 derives it from STATIC_ROOT: one well-known directory, not
# two variables that must agree.
RUN mkdir -p /app/web/.well-known && chown -R node:node /app/web/.well-known \
    && chmod +x /app/entrypoint.sh

ENV BIND_HOST=0.0.0.0
ENV STATIC_ROOT=/app/web

USER node
EXPOSE 3031

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3031/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
```

**3e.** Create `docker/entrypoint.sh`:

```sh
#!/bin/sh
# §11.3: generate <STATIC_ROOT>/.well-known/assetlinks.json, then exec the
# server. `exec` and not a background start, so the server is PID 1 and a
# `docker stop` reaches it.
#
# The generator exits 1 on a malformed fingerprint, and `set -e` makes that stop
# the container. That is deliberate: a container that serves a VALID-LOOKING
# assetlinks.json naming a fingerprint that signs nothing is spec §2's silent
# failure with a false trail of evidence beside it.
set -e

node /app/tools/write-assetlinks.mjs

exec node /app/main.mjs
```

**3f.** Create `compose.yaml`. Write the uncommented half by hand — it is below, complete — and **generate the commented half**, because no number in it may be invented (§0: *"Invented numbers — forbidden where a published table or a template already carries the number"*), and rule 3 of the drift test asserts every one of them against `ENV_SCHEMA`.

First the file:

```yaml
services:
  tapkart:
    image: ghcr.io/atvriders/tapkart:latest
    restart: unless-stopped
    ports:
      - "3031:3031"
    environment:
      # ---- read by the entrypoint at container start, never by the server ----
      # The APK's applicationId. It must equal the Gradle applicationId, or
      # Android's verifier rejects the statement and the tap opens a browser —
      # silently, on every Android 12 or newer device.
      TAPKART_ANDROID_PACKAGE: "io.github.atvriders.tapkart"
      # The SHA-256 fingerprint of the certificate that signed the INSTALLED
      # APK, upper case and colon separated. A comma-separated LIST, so a
      # locally built debug APK can verify too.
      # SUBSTITUTE YOUR OWN — the value below is a placeholder and signs nothing.
      TAPKART_SHA256_FINGERPRINTS: "DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF"

      # ---- the server's own settings; every one shown with its default ----
      # Uncomment a line to change it. See docs/server-env.md for what each does.
      # BEGIN GENERATED DEFAULTS — see Step 3f; do not hand-edit
      # END GENERATED DEFAULTS
```

Then generate the block between the two markers:

```bash
cat > /tmp/tapkart-env-block.mjs <<'EOF'
import { build } from 'esbuild'
const out = await build({
  stdin: { contents: "export { ENV_SCHEMA } from '@tapkart/server'", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false,
})
const url = 'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text, 'utf8').toString('base64')
const { ENV_SCHEMA } = await import(url)
for (const spec of ENV_SCHEMA) {
  if (spec.name.startsWith('TAPKART_')) continue      // set uncommented above
  if (spec.name === 'BIND_HOST' || spec.name === 'STATIC_ROOT') continue  // set in the image
  if (spec.defaultValue === null) { console.log(`      ${spec.name}: ""   # REQUIRED`); continue }
  console.log(`      # ${spec.name}: "${spec.defaultValue}"`)
}
EOF
node /tmp/tapkart-env-block.mjs
```

Paste its output between `# BEGIN GENERATED DEFAULTS` and `# END GENERATED DEFAULTS`, keeping the two marker lines. Every line it prints is `ENV_SCHEMA`'s own `defaultValue`, *"as a string, exactly as it would be written in a compose file"* — which is precisely what rule 3 compares against, so the loop is closed and no default is ever typed by a human.

`ICE_SERVERS` is one of the rows it prints, and its default is a **third-party endpoint contacted at connection time**. §11.5 puts the disclosure in `docs/server-env.md` (Plan 4's) and requires the README to repeat the one sentence naming it; that README edit is Task 21's.

**3g.** In the root `package.json`, add the `build` script (§15.2):

```json
    "build": "npm run build --workspaces --if-present"
```

§15.2 also names an `e2e` script. **It is not added here**: C-4 gives Plan 4 the Playwright harness *"and the `test:e2e` script"* by name, so a second root alias would be a second name for one thing — and a second name is what C-1, C-6 and C-7 each exist to prevent. Task 20's CI job runs `npm run test:e2e`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run apps/web/test/deploy-env.test.ts
npm run typecheck -w @tapkart/web
npx vitest run
```

Expected: **16 passed** in `deploy-env.test.ts` (6 union + 3 L3 + 6 image + 1 sanity), no typecheck output — `tools/**/*.ts` is now in the app program (§8.4), so `write-assetlinks.ts` is typechecked for the first time — and the whole suite green.

Then prove the drift test detects drift, because a drift test that has never caught anything is a drift test nobody knows works. Add a line `FOO_BAR: "1"` to the compose `environment:` block and re-run:

Expected: **rule 2 fails**, `expected [ 'FOO_BAR' ] to deeply equal []`. Remove it. Then change one commented default's value by a digit:

Expected: **rule 3 fails**, naming the variable, what compose says and what `ENV_SCHEMA` says. Put it back.

Then build and run the image, which is the only thing that proves the two stages fit together:

```bash
docker build -t tapkart:local .
docker run --rm -d --name tapkart-local -p 3031:3031 \
  -e TAPKART_ANDROID_PACKAGE=io.github.atvriders.tapkart \
  -e TAPKART_SHA256_FINGERPRINTS=DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF \
  tapkart:local
curl -sS -o /dev/null -w '%{http_code} %{content_type} %{num_redirects}\n' http://127.0.0.1:3031/.well-known/assetlinks.json
curl -sS http://127.0.0.1:3031/.well-known/assetlinks.json
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3031/healthz
docker rm -f tapkart-local
```

Expected: `200 application/json 0` — the content type and, crucially, **zero redirects**; a statement whose `relation` is `delegate_permission/common.handle_all_urls` and whose `sha256_cert_fingerprints[0]` is the placeholder; and `200` from `/healthz`.

**That the container comes up at all with both `TAPKART_*` set is L3's test** (§12.2 assertion 30), and Task 20 makes it a gating CI job. If the container exits at start with a message naming an unknown `TAPKART_` variable, Plan 4's `ENV_SCHEMA` has not yet gained the two rows §18.1 specifies — that is the fix, in Plan 4's `src/env.ts`, and not an exemption in `parseConfig` or an `unset` in the entrypoint, because both of those create a second list of variable names.

Then the self-hoster-with-no-APK path, which §12.2 assertion 31 makes a job of its own:

```bash
docker run --rm -d --name tapkart-bare -p 3031:3031 tapkart:local
docker logs tapkart-bare 2>&1 | head -3
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3031/healthz
docker rm -f tapkart-bare
```

Expected: one log line saying no `assetlinks.json` was written and why, then `200` from `/healthz`. A self-hoster with no APK gets a working server.

And the malformed case, which must be loud:

```bash
docker run --rm -e TAPKART_ANDROID_PACKAGE=io.github.atvriders.tapkart \
  -e TAPKART_SHA256_FINGERPRINTS=nonsense tapkart:local
```

Expected: the container **exits non-zero** with `write-assetlinks: TAPKART_SHA256_FINGERPRINTS: …`. A misconfigured fingerprint fails loudly instead of serving a valid-looking statement that signs nothing.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore docker/entrypoint.sh compose.yaml apps/web/tools/write-assetlinks.ts apps/web/test/deploy-env.test.ts apps/web/package.json package.json package-lock.json && git commit -m "feat(deploy): the image, the compose file, the assetlinks generator, and C-6's drift test (§11)"
```
