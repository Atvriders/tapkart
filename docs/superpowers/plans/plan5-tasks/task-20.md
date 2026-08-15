### Task 20: CI and release — the five jobs, the container assertions, and the two Playwright specs

**Files:**
- Create: `.github/workflows/ci.yml` — contract §12.1
- Create: `.github/workflows/release.yml` — contract §12.1
- Create: `docker/assert-container.sh` — §12.2 assertions 30 and 31
- Create: `e2e/offline-solo.spec.ts` — §12.3 assertion 33
- Create: `e2e/assetlinks-network-only.spec.ts` — §12.3 assertion 34

**Ordering:** last of the mechanical tasks — after **13–19**, because every job below runs something one of them created. Task 21 (the README and the owner checklist) is the only thing after it.

**Interfaces:**

- **Consumes** — the scripts and entry points the earlier tasks produced, by exact path:

  ```
  apps/android/scripts/assert-pins.sh          (Task 13)  §12.2 assertion 25
  apps/android/scripts/write-invite-constants.mjs (Task 14)  the generated-file freshness check
  apps/android/scripts/assert-manifest.mjs     (Task 14)  §12.2 assertions 19-24
  apps/android/scripts/assert-signing.sh       (Task 12)  §6.5's wiring
  apps/web/tools/build-sw.mjs                  (Task 16)  §12.2 assertions 26, 27, run by the build
  docker/entrypoint.sh                         (Task 19)
  npm run build -w @tapkart/web                (Task 16)
  npm run test:e2e                             (Plan 4, C-4)
  ```

- **Consumes** — Plan 3's `data-testid` contract, which the two specs drive. These names are **Plan 4's contract, not Plan 3's**, and *"a testid that does not match is the same silent failure as a mismatched CSS selector"* — so they are read here and never renamed:

  ```
  solo-button    Title screen, dispatches { kind: 'soloPressed' }   (added by Task 18)
  race-canvas    Race screen, the canvas startShell renders into
  lap-counter    Race screen, the HUD's lap text, e.g. "2/3"
  ```

- **Consumes** — the CI secrets and variables §12.1 fixes:

  ```
  Secrets:   ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD,
             ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD
  Variables: TAPKART_ORIGIN, TAPKART_ANDROID_PACKAGE, TAPKART_SHA256_FINGERPRINTS
  ```

  A fingerprint is a **variable, not a secret** (P5 Q35): *"it is published to the world in `assetlinks.json` by design; §1 forbids it in a repo file, and a variable is not a file."*

- **Produces** — no exported symbol. Two workflows, one script and two specs.

**This task has no failing test to write, and pretending otherwise would be the defect.** A GitHub Actions workflow cannot be run by vitest, and a test that greps YAML for a job name proves the YAML contains a string. The verification is the artifact: `act` or a pushed branch for the workflows, `docker` for the container script, and `npm run test:e2e` for the specs — the specs *are* real tests and they do have a RED.

**F-P5-33, and the sentence it protects.** *"`latest` moves on `v*` tags **only**; `master` publishes `edge`."* The reason is one line in §11.1: *"The README's compose file must not mean 'whatever merged five minutes ago', because that makes 'just run the compose file' an unpredictable instruction."* Self-hosters who want head use `edge`, explicitly. Every push that publishes also tags the version and the commit SHA (P5 Q34).

**The `container` job is gating, not informational** (P5 Q34): *"it is the only thing that proves the served `assetlinks.json` exists with the right content type and no redirect, which is spec §2's silent-failure mode."*

**Ecosystem facts this repo has already paid to learn** (§12.1), recorded so nobody rediscovers them: Actions are enabled for the `Atvriders` org and GHCR packages publish and default to public; a **forked** repo's first workflow run needs a manual `workflow_dispatch` before push-triggered runs work; and a PR from a fork has **no secrets**, which is why release signing is tag-only and PRs build debug.

**Action versions are pinned here and nowhere else.** §0: *"Every third-party version… is pinned **once**… and every other task reads the pinned value. No task bumps a version to make its own step pass."* These two files are the only place a GitHub Action version appears in this repository.

**What these jobs prove, and the four things they cannot** (§14). The `android` job builds an APK, asserts its manifest and its certificate, and **never once establishes that a tap works** — HCE needs two physical devices in antenna contact. The `container` job proves the container serves `assetlinks.json` correctly on loopback and proves nothing about the owner's tunnel. The `e2e` job proves the offline path works in a real browser with a real service worker, and proves nothing about how the game feels on a phone. Every gap is item-numbered in `docs/owner-verification.md`, which Task 21 writes.

---

- [ ] **Step 1: Write the failing test**

The two Playwright specs are the testable half of this task, and they fail for the right reason before the workflows exist: the offline path has never been exercised in a browser.

Create `e2e/offline-solo.spec.ts` — §12.3 assertion 33:

```ts
import { expect, test } from '@playwright/test'

/**
 * F-P5-26 makes offline solo a REQUIREMENT that gates the build:
 *
 *   "It is what makes this a PWA rather than a website, and the game is fully
 *    playable solo against bots with zero server involvement — the offline story
 *    here is unusually complete, so shipping it as 'nice-to-have' would waste
 *    something already true."
 *
 * Task 16's build-time gate proves every precache entry EXISTS. This proves the
 * app RUNS from them, in a real browser, with a real service worker and the
 * network switched off. Neither substitutes for the other.
 *
 * It runs against the BUILT app, not the dev server: `dist/sw.js` is emitted by
 * `tools/build-sw.mjs` and a Vite dev server has no service worker at all.
 */
test('the installed app opens and runs a solo race with the network off', async ({ page, context }) => {
  // Fail here, naming the cause, rather than twenty lines later with a timeout
  // that reads as "the game is broken".
  const swResponse = await page.request.get('/sw.js')
  expect(
    swResponse.status(),
    'GET /sw.js did not return 200 — run `npm run build -w @tapkart/web` and serve dist/',
  ).toBe(200)

  await page.goto('/')

  // The worker must be CONTROLLING the page, not merely registered: an
  // installed-but-not-activated worker answers nothing, and a test that waited
  // only for registration would go offline before the cache was usable and
  // report a bug in the wrong place.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 30_000,
  })

  await context.setOffline(true)
  await page.reload()

  // The shell renders from the cached shell document.
  await expect(page.getByTestId('solo-button')).toBeVisible()

  await page.getByTestId('solo-button').click()

  // A solo race STARTS...
  await expect(page.getByTestId('race-canvas')).toBeVisible({ timeout: 20_000 })

  // ...and RUNS. The lap counter is HUD text driven by the simulation, so it can
  // only appear if the tick loop is turning — which is the difference between
  // "the shell rendered" and "the game works offline".
  await expect(page.getByTestId('lap-counter')).toHaveText(/[1-3]\s*\/\s*3/, { timeout: 20_000 })

  // Still running a moment later, with the network still off: a race that
  // renders one frame and then stalls on a failed fetch would have satisfied
  // every assertion above.
  await page.waitForTimeout(2_000)
  await expect(page.getByTestId('race-canvas')).toBeVisible()
  await expect(page.getByTestId('lap-counter')).toHaveText(/[1-3]\s*\/\s*3/)

  await context.setOffline(false)
})
```

Create `e2e/assetlinks-network-only.spec.ts` — §12.3 assertion 34:

```ts
import { expect, test } from '@playwright/test'

/**
 * `routeRequest`'s `networkOnly` rule, end to end.
 *
 * §8.3: "/.well-known/ being networkOnly is NOT about the Android verifier —
 * that fetch never passes through a page's service worker — it is so a developer
 * never debugs a stale assetlinks.json served out of a browser cache."
 *
 * Task 15 asserts the rule as a pure function, including that a NAVIGATION to
 * this path is networkOnly and not shellFallback. This asserts that the worker
 * actually executes it.
 */
test('/.well-known/assetlinks.json is served from the network and lands in no cache', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 30_000,
  })

  const result = await page.evaluate(async () => {
    const url = new URL('/.well-known/assetlinks.json', location.origin).toString()
    const response = await fetch(url)
    const status = response.status
    const contentType = response.headers.get('content-type')

    // Every cache the worker owns, not just the current one: a stale
    // `tapkart-<old>` cache holding this path is the exact failure the rule
    // exists to prevent.
    const names = await caches.keys()
    const cached: string[] = []
    for (const name of names) {
      const cache = await caches.open(name)
      const hit = await cache.match(url)
      if (hit !== undefined) cached.push(name)
    }
    return { status, contentType, names, cached }
  })

  expect(result.status).toBe(200)
  expect(result.contentType).toContain('application/json')
  // The suite is meaningless if the worker cached nothing at all, so assert the
  // caches exist before asserting this path is absent from them.
  expect(result.names.some((n) => n.startsWith('tapkart-'))).toBe(true)
  expect(result.cached).toEqual([])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build -w @tapkart/web && npm run test:e2e -- offline-solo assetlinks-network-only`

Expected: **2 failed.** The service worker has never been registered against a served build, so both specs time out at the same line, and the message names it:

```
Error: page.waitForFunction: Timeout 30000ms exceeded.
    at e2e/offline-solo.spec.ts:… navigator.serviceWorker.controller !== null
```

If instead the first assertion fails with `GET /sw.js did not return 200`, the Playwright web server is serving the source tree rather than `apps/web/dist` — fix `playwright.config.ts`'s `webServer` (Plan 4's file, C-4), not this spec.

- [ ] **Step 3: Write the implementation**

**3a.** Create `docker/assert-container.sh` — §12.2 assertions 30 and 31, in a script rather than inline YAML so the same check runs on a laptop:

```bash
#!/usr/bin/env bash
#
# §12.2 assertions 30 and 31, over a BUILT image.
#
# Usage:  bash docker/assert-container.sh <image-tag>
#
# Assertion 30 is also L3's test: the container is started WITH both TAPKART_*
# variables, so a server whose parseConfig rejects them fails CI rather than the
# owner's deploy (§18.1).
set -euo pipefail

image="${1:?usage: assert-container.sh <image-tag>}"
port=3031

# §1: an obviously-fake, format-valid fingerprint. Never a real one, anywhere.
fingerprint="DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF"
package="io.github.atvriders.tapkart"

cleanup() {
  docker rm -f tapkart-assert >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  docker logs tapkart-assert 2>&1 | tail -40 >&2 || true
  exit 1
}

wait_for_health() {
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$port/healthz" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

echo "== 30a. the container starts WITH both TAPKART_ variables set =="
cleanup
docker run -d --name tapkart-assert -p "$port:$port" \
  -e "TAPKART_ANDROID_PACKAGE=$package" \
  -e "TAPKART_SHA256_FINGERPRINTS=$fingerprint" \
  "$image" >/dev/null
wait_for_health || fail "the container never became healthy with both TAPKART_ variables set.
  Plan 4's parseConfig throws on an UNKNOWN variable with the TAPKART_ prefix, so if the log below
  names one of these two, ENV_SCHEMA has not gained the two rows §18.1 specifies. The fix is those
  two rows — not an exemption in parseConfig, and not unsetting them in the entrypoint, because
  both create a second list of variable names, which is what C-6 exists to prevent."

echo "== 30b. /.well-known/assetlinks.json: 200, application/json, NO redirect =="
# --max-redirs 0 and no -L: any 3xx fails the job. Spec §2 and §9 both demand no
# redirect, and a tunnel or proxy adding one is exactly how App Links break with
# nothing in any log.
read -r code ctype redirects < <(
  curl -sS --max-redirs 0 -o /tmp/tapkart-assetlinks.json \
    -w '%{http_code} %{content_type} %{num_redirects}\n' \
    "http://127.0.0.1:$port/.well-known/assetlinks.json"
) || fail "the request itself failed"

[ "$code" = "200" ] || fail "expected HTTP 200, got $code"
[ "$redirects" = "0" ] || fail "the response redirected ($redirects hop(s)); C-2 requires none"
case "$ctype" in
  application/json*) ;;
  *) fail "expected Content-Type application/json, got '$ctype'" ;;
esac

echo "== 30c. the body is a statement validateAssetLinks accepts =="
node --input-type=module -e "
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
const out = await build({
  stdin: { contents: \"export { validateAssetLinks } from '@tapkart/invite'\", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false,
})
const url = 'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text, 'utf8').toString('base64')
const { validateAssetLinks } = await import(url)
const problems = validateAssetLinks(JSON.parse(readFileSync('/tmp/tapkart-assetlinks.json', 'utf8')))
if (problems.length > 0) { console.error(problems.join('\n')); process.exit(1) }
console.log('  statement is valid')
" || fail "the served statement did not validate"

echo "== 31. the container starts with NO TAPKART_ variables and still serves /healthz =="
cleanup
docker run -d --name tapkart-assert -p "$port:$port" "$image" >/dev/null
wait_for_health || fail "a self-hoster with no APK could not start the server (P5 Q37)"
docker logs tapkart-assert 2>&1 | grep -q 'no assetlinks.json written' ||
  fail "the entrypoint did not log why it wrote no assetlinks.json"

echo "OK: the container serves assetlinks.json correctly, and starts without it."
```

Make it executable: `chmod +x docker/assert-container.sh`

**3b.** Create `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  # §1: never a real origin in a repo file. `vars.TAPKART_ORIGIN` overrides it
  # where it is set, which is what makes §12.2 assertion 21 meaningful.
  TAPKART_ORIGIN: ${{ vars.TAPKART_ORIGIN || 'https://tapkart.example' }}

jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      # BOTH tsconfigs (§8.4). `dom` and `webworker` cannot coexist in one
      # program, and this is the command that would have failed the moment
      # sw.ts landed without the split.
      - run: npm run typecheck --workspaces --if-present
      - run: npm test
      # The build IS §12.2 assertions 26 and 27 plus F-P5-26's offline gate:
      # tools/build-sw.mjs fails when a precache entry is missing, when sw.js is
      # not at the root of dist/, or when a declared icon is absent or the wrong
      # size.
      - run: npm run build -w @tapkart/web
      - uses: actions/upload-artifact@v4
        with:
          name: web-dist
          path: apps/web/dist
          retention-days: 1

  android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      # JDK 21 (spec §9, P5 Q32).
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
      - uses: android-actions/setup-android@v3
      - uses: gradle/actions/setup-gradle@v4
      - run: npm ci

      # C-1's freeze, mechanically: the committed generated file must still be
      # what the shipped LOBBY_PATH_PREFIX produces.
      - name: the invite constants are freshly generated
        run: |
          node apps/android/scripts/write-invite-constants.mjs
          git diff --exit-code apps/android/gradle/invite-constants.properties

      # §5.7's golden exchange, in Kotlin, against the SAME fixture the
      # TypeScript replays. This is the whole of what CI can prove about the tap.
      - run: ./gradlew -p apps/android :app:testDebugUnitTest

      - run: ./gradlew -p apps/android :app:assembleDebug

      # §12.2 assertions 19-24 over the MERGED manifest, and 25 over the
      # configured project.
      - run: node apps/android/scripts/assert-manifest.mjs
      - run: bash apps/android/scripts/assert-pins.sh
      - run: bash apps/android/scripts/assert-signing.sh

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      # The service worker only exists in a build, so the harness serves dist/.
      - run: npm run build -w @tapkart/web
      - run: npm run build -w @tapkart/server
      # Plan 4 owns the harness (C-4); Plan 5 owns this job and adds two specs.
      # F-P5-26 makes the offline spec GATING.
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report
          retention-days: 7

  container:
    # Gating, not informational (P5 Q34): it is the only thing that proves the
    # served assetlinks.json exists with the right content type and no redirect,
    # which is spec §2's silent-failure mode.
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - uses: docker/setup-buildx-action@v3
      - name: build the image for this runner's architecture only
        run: docker build -t tapkart:ci .
      - run: bash docker/assert-container.sh tapkart:ci

  edge-image:
    # F-P5-33: master publishes `edge`. `latest` moves on v* tags ONLY, so the
    # README's compose file means a release and not whatever merged five minutes
    # ago.
    if: github.event_name == 'push' && github.ref == 'refs/heads/master'
    needs: [web, android, e2e, container]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            ghcr.io/atvriders/tapkart:edge
            ghcr.io/atvriders/tapkart:sha-${{ github.sha }}
      # §12.2 assertion 32.
      - name: both platforms are in the pushed manifest
        run: |
          docker buildx imagetools inspect "ghcr.io/atvriders/tapkart:edge" | tee /tmp/inspect.txt
          grep -q 'linux/amd64' /tmp/inspect.txt || { echo "amd64 missing"; exit 1; }
          grep -q 'linux/arm64' /tmp/inspect.txt || { echo "arm64 missing"; exit 1; }
```

**3c.** Create `.github/workflows/release.yml`:

```yaml
name: release

on:
  push:
    tags:
      - 'v*'

env:
  TAPKART_ORIGIN: ${{ vars.TAPKART_ORIGIN || 'https://tapkart.example' }}

jobs:
  image:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      # F-P5-33: `latest` moves HERE and only here.
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            ghcr.io/atvriders/tapkart:latest
            ghcr.io/atvriders/tapkart:${{ github.ref_name }}
            ghcr.io/atvriders/tapkart:sha-${{ github.sha }}
      - name: both platforms are in the pushed manifest
        run: |
          docker buildx imagetools inspect "ghcr.io/atvriders/tapkart:${{ github.ref_name }}" | tee /tmp/inspect.txt
          grep -q 'linux/amd64' /tmp/inspect.txt || { echo "amd64 missing"; exit 1; }
          grep -q 'linux/arm64' /tmp/inspect.txt || { echo "arm64 missing"; exit 1; }

  apk:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
      - uses: android-actions/setup-android@v3
      - uses: gradle/actions/setup-gradle@v4
      - run: npm ci
      # F-P5-10: the APK bundles the web build.
      - run: npm run build -w @tapkart/web
      - run: npm --prefix apps/android exec cap sync android

      # §6.5: decoded to $RUNNER_TEMP, NEVER into the workspace, and never
      # uploaded as an artifact. One `git add -A` from inside the tree publishes
      # a signing key forever, and a key committed once is compromised forever.
      - name: decode the keystore outside the workspace
        env:
          ANDROID_KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
        run: |
          test -n "$ANDROID_KEYSTORE_BASE64" || {
            echo "ANDROID_KEYSTORE_BASE64 is empty. A release build MUST be signed by the same"
            echo "certificate every time, or no static assetlinks.json can ever match and App Links"
            echo "fail SILENTLY on every Android 12 or newer device."
            exit 1
          }
          printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$RUNNER_TEMP/tapkart-release.jks"

      - name: build the signed release APK
        env:
          TAPKART_KEYSTORE_PATH: ${{ runner.temp }}/tapkart-release.jks
          TAPKART_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          TAPKART_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          TAPKART_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
        run: ./gradlew -p apps/android :app:assembleRelease

      - name: the manifest still satisfies §12.2's assertions
        run: node apps/android/scripts/assert-manifest.mjs

      - name: §12.2 assertion 28 — the certificate is the one the deployment names
        env:
          EXPECTED: ${{ vars.TAPKART_SHA256_FINGERPRINTS }}
        run: |
          set -euo pipefail
          apk="$(find apps/android/app/build/outputs/apk/release -name '*.apk' | head -1)"
          test -n "$apk" || { echo "no release APK was produced"; exit 1; }
          case "$apk" in
            *unsigned*) echo "the release APK is UNSIGNED — CI rejects it rather than shipping it"; exit 1 ;;
          esac
          apksigner="$(find "$ANDROID_HOME/build-tools" -name apksigner | sort | tail -1)"
          "$apksigner" verify --print-certs "$apk" | tee /tmp/certs.txt
          # apksigner prints the digest lowercase and unseparated; the repository
          # variable is upper case and colon separated (§4.7). Normalise BOTH, or
          # the comparison fails for a reason nobody can see.
          actual="$(sed -n 's/.*SHA-256 digest: *\([0-9a-fA-F]*\).*/\1/p' /tmp/certs.txt | head -1 | tr 'A-F' 'a-f')"
          first="$(printf '%s' "$EXPECTED" | cut -d, -f1 | tr -d ' :' | tr 'A-F' 'a-f')"
          test -n "$actual" || { echo "apksigner printed no SHA-256 digest"; exit 1; }
          test -n "$first" || { echo "the TAPKART_SHA256_FINGERPRINTS variable is empty"; exit 1; }
          if [ "$actual" != "$first" ]; then
            echo "the APK's certificate does not match the first entry of TAPKART_SHA256_FINGERPRINTS."
            echo "App Links would fail SILENTLY on every Android 12 or newer device: no chooser, no"
            echo "error, the link just opens in a browser."
            exit 1
          fi
          echo "certificate matches"

      - name: §12.2 assertion 29 — the applicationId is the one assetlinks.json names
        env:
          EXPECTED: ${{ vars.TAPKART_ANDROID_PACKAGE }}
        run: |
          set -euo pipefail
          apk="$(find apps/android/app/build/outputs/apk/release -name '*.apk' | head -1)"
          aapt2="$(find "$ANDROID_HOME/build-tools" -name aapt2 | sort | tail -1)"
          actual="$("$aapt2" dump packagename "$apk" | tr -d '\r\n')"
          expected="${EXPECTED:-io.github.atvriders.tapkart}"
          test "$actual" = "$expected" || {
            echo "the APK's applicationId is '$actual' but the deployment names '$expected' (§3 value 4)"
            exit 1
          }
          echo "applicationId matches"

      # Spec §9: "published as a GitHub Release asset, since the owner is
      # responsible for on-device NFC verification." No Play Store, no App
      # Bundle, no internal track.
      - name: upload the APK to the release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          apk="$(find apps/android/app/build/outputs/apk/release -name '*.apk' | head -1)"
          cp "$apk" "$RUNNER_TEMP/app-release.apk"
          gh release upload "${{ github.ref_name }}" "$RUNNER_TEMP/app-release.apk" --clobber
```

- [ ] **Step 4: Run the verification**

The two specs have a real green:

```bash
npm run build -w @tapkart/web
npm run build -w @tapkart/server
npm run test:e2e
```

Expected: the whole Playwright suite green, including Plan 4's `join-and-race` and both specs above. The offline spec is the one that matters most: **it is F-P5-26's gate**, and a failure there means the app that installs on a phone does not open on a plane.

The container script has a real green too:

```bash
docker build -t tapkart:local .
bash docker/assert-container.sh tapkart:local
```

Expected:

```
== 30a. the container starts WITH both TAPKART_ variables set ==
== 30b. /.well-known/assetlinks.json: 200, application/json, NO redirect ==
== 30c. the body is a statement validateAssetLinks accepts ==
  statement is valid
== 31. the container starts with NO TAPKART_ variables and still serves /healthz ==
OK: the container serves assetlinks.json correctly, and starts without it.
```

The workflows are declarations and are verified by running them. In order:

1. **Syntax, before pushing anything:**
   Run: `npx --yes yaml-lint .github/workflows/ci.yml .github/workflows/release.yml` — or, with no network, `node -e "const {readFileSync}=require('node:fs');for(const f of ['.github/workflows/ci.yml','.github/workflows/release.yml']){const t=readFileSync(f,'utf8');if(!/^jobs:/m.test(t))throw new Error(f+' has no jobs');console.log(f,'ok')}"`.
   Expected: both files named, no error. This proves the file parses and nothing more — say so rather than calling it a test.

2. **Push a branch and read the run.** Expected: `web`, `android`, `e2e` and `container` all green; `edge-image` **skipped**, because the branch is not `master`. If `edge-image` runs on a branch, its `if:` is wrong and every branch push is about to move a published tag.

3. **Merge to master.** Expected: `edge-image` runs and pushes `edge` and `sha-<short>` — **and `latest` does not move.** Check it explicitly, because F-P5-33 is a rule about what does *not* happen:
   Run: `docker buildx imagetools inspect ghcr.io/atvriders/tapkart:latest --format '{{.Manifest.Digest}}'` before and after the merge.
   Expected: the same digest both times.

4. **Confirm the package is public**, this repo's standing rule — *"a first publish that lands private is a bug to fix, not a state to accept"*:
   Run: `docker logout ghcr.io && docker pull ghcr.io/atvriders/tapkart:edge`
   Expected: it pulls. If it asks for credentials, set the package's visibility to public in the org's package settings.

5. **Tag a release.** Expected: `image` pushes `latest`, the tag and the SHA with both platforms; `apk` produces a signed APK, both fingerprint and applicationId assertions pass, and the APK is attached to the Release.

   If the `apk` job fails at the certificate check, **do not change the assertion.** It is the one mechanical thing standing between the project and spec §2's silent failure. Either the keystore secret is not the one whose fingerprint is in `TAPKART_SHA256_FINGERPRINTS`, or the variable is stale — fix whichever, and read `README.md`'s *Signing the Android app* section, which Task 12 wrote.

**And now the honest part.** After all five jobs are green, the following are still completely unverified, and every one of them is an item in `docs/owner-verification.md`:

- **that the tap works** — HCE needs two physical devices in antenna contact, and no runner has two phones;
- **that Android's App Links verifier succeeded** — it runs on-device, against the real domain, for the installed certificate. CI proved every *input* to the verifier is correct and self-consistent, which is a different sentence;
- **that the origin the owner deploys is that container** — the Cloudflare Tunnel config is the owner's and its hostname is not in the repo;
- **that the second entry point fires on a real Android 15 phone** — the OS decides which intent an NDEF tag raises;
- **that the game sounds right, that the QR scans, and how any of it feels on a phone.**

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml docker/assert-container.sh e2e/offline-solo.spec.ts e2e/assetlinks-network-only.spec.ts && git commit -m "ci: five jobs, the container assertions, and the offline/networkOnly specs (§12, F-P5-26, F-P5-33)"
```
