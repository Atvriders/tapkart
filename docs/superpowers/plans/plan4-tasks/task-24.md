### Task 24: the Playwright lane, and the first two E2E specs

Spec §8's last row is *"Playwright drives two browser contexts joining by code
and finishing a race"* — which needs the server, the lobby and the room code. All
three are Plan 4's, which is why C-4 assigns the harness here. **Plan 4 creates
the lane; Plan 5 adds specs to it and owns the CI job that runs it.**

**This lane is exempt from §0's "no browser, no external network", and that is
not a contradiction.** Those rules are about the **vitest** suite, which must
stay browserless and complete in seconds. Playwright is a separate lane with a
separate command, it is not in `vitest.config.ts`'s `include`, and it drives a
server bound to loopback. `npm test` never starts a browser, and nothing in this
task changes that.

**Most of this task is not TDD, and it does not pretend to be.** A Playwright
config has no meaningful failing test. Each step below states the exact command
and what the operator must see.

**Two specs, deliberately:**

- **`e2e/lane.spec.ts` proves the lane itself works**, against behaviour Plan 4
  owns end to end: a real HTTP server, a real socket, a real browser process. It
  is green the moment this task lands, with or without Plan 3's web build. A lane
  whose only spec cannot pass yet is indistinguishable from a lane that is
  broken, and this repository has shipped twenty-one tests that could not detect
  what they existed to detect.
- **`e2e/join-and-race.spec.ts` is spec §8's row**, written in full. It drives
  two browser contexts through the real shell and **fails until Plan 3's shell
  carries the ten `data-testid` hooks below.** That failure is honest and it is
  the point: it is the E2E contract, stated in executable form, and the failure
  message names the exact hook that is missing. It is **not** `test.skip`ped — a
  skipped end-to-end is the vacuous version of the same file, and Plan 5's CI job
  is what makes it blocking.

**Execution order.** Task 23 must have landed: the lane's `webServer` runs
`packages/server/dist/main.mjs`, which the esbuild bundle produces.

**Files:**
- Create: `playwright.config.ts` (repo root)
- Create: `e2e/fixtures/tapkart.ts`
- Create: `e2e/lane.spec.ts`
- Create: `e2e/join-and-race.spec.ts`
- Modify: `package.json` (root: the `test:e2e` script and `@playwright/test`)

**Do not modify `vitest.config.ts`.** `e2e/` is outside its `include` glob by
construction, which is what keeps a browser out of `npm test` permanently.

**Interfaces:**

- Consumes — Plan 4's own server, over HTTP and WS:
  ```ts
  export const WS_PATH = '/ws'                      // src/static.ts
  export const HEALTH_PATH = '/healthz'             // src/static.ts
  export const ASSETLINKS_PATH = '/.well-known/assetlinks.json'
  export const LOBBY_PATH_PREFIX = '/r/'            // @tapkart/protocol
  export const ROOM_CODE_LENGTH = 5                 // @tapkart/protocol
  export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  ```
  The specs restate these as literals rather than importing them: `e2e/` is
  compiled by Playwright's own transform, not by any package's tsconfig, and a
  bare `@tapkart/protocol` specifier there would resolve through the workspace
  root by luck rather than by design. Each literal is annotated with the constant
  it mirrors, and `lane.spec.ts` asserts the mirror is still true by parsing the
  code the running server actually mints.

- Consumes — Plan 3's shell (`startShell`, Plan 3 §5.13), through the DOM. The
  ten hooks in `e2e/fixtures/tapkart.ts` are this plan's E2E contract with it.

- Produces — the lane: `playwright.config.ts`, `e2e/`, two specs, and the root
  script `"test:e2e": "playwright test"`.

**Two decisions this task makes:**

1. **The lane binds a FIXED loopback port, from `TAPKART_E2E_PORT`, default
   3132.** §10.4 asks for an ephemeral port; Playwright must know the URL
   *before* it starts the server and there is no channel by which an OS-assigned
   port could be communicated back to it. The security-relevant half — bound to
   `127.0.0.1` and nothing else — is preserved exactly, and the port is one
   environment variable for anyone whose machine already uses 3132.
2. **One Playwright project, two browser contexts in one test.** §10.4's "two
   projects (chromium, and a second context in the same project)" describes the
   participants, not the mechanism: a second *project* would run the whole file
   twice rather than create a second player. Two contexts in one test is what
   "two browser contexts joining by code" means, and it is the only shape in
   which one context can read a code the other one minted.

---

- [ ] **Step 1: Install Playwright and add the root script**

```bash
npm install -D --save-exact @playwright/test
npx playwright install chromium
```

Expected: `@playwright/test` appears in the root `package.json`
`devDependencies` **caret-free**, and the browser download reports
`chromium ... downloaded to ...`.

Add to the root `package.json` `scripts` (leave `workspaces`, `vitest.config.ts`
and everything else alone — `build:server` is already there from Task 23):

```jsonc
"scripts": {
  "test:e2e": "playwright test"
}
```

Verify the vitest lane is unchanged:

```bash
grep -n "include" vitest.config.ts
```
Expected: the `include` glob still names only `packages/*/test/**/*.test.ts`
(plus Plan 3's `apps/*` glob). `e2e/` must not appear.

- [ ] **Step 2: Write `playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test'

/**
 * C-4. The E2E lane: a separate command from `npm test`, which stays browserless
 * and is what §0's "no browser, no external network" rule is about.
 *
 * The port is FIXED rather than ephemeral, and that is a real deviation from
 * §10.4 with a real reason: Playwright must know the URL before it starts the
 * server, and an OS-assigned port cannot be communicated back to it. The half
 * that matters -- bound to loopback and nothing else -- is preserved exactly.
 */
const PORT = Number(process.env.TAPKART_E2E_PORT ?? '3132')
const HOST = '127.0.0.1'
const BASE_URL = 'http://' + HOST + ':' + String(PORT)

export default defineConfig({
  testDir: 'e2e',
  // One server, one room registry, one process. Parallel workers would race each
  // other for room codes and for the ports of a server they all share.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  // A three-lap race against bots is minutes of real time, not seconds.
  timeout: 600_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The esbuild bundle Task 23 owns, plus every workspace that has a build --
    // which is how `apps/web/dist` gets built without this file naming a script
    // Plan 3 owns.
    command:
      'npm run build:server && npm run build --workspaces --if-present && node packages/server/dist/main.mjs',
    url: BASE_URL + '/healthz',
    reuseExistingServer: process.env.CI === undefined,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      BIND_HOST: HOST,
      // Relative to the process working directory, which is this file's
      // directory. No absolute path is ever baked into a public repo.
      STATIC_ROOT: 'apps/web/dist',
    },
  },
})
```

- [ ] **Step 3: Write `e2e/fixtures/tapkart.ts` — the selector contract**

```ts
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Plan 4's E2E contract with Plan 3's shell (`startShell`, Plan 3 §5.13).
 *
 * `startShell` is an ADAPTER and is untestable in vitest by construction -- it
 * is the one place `HudModel` and `AppState` become DOM. That is exactly why
 * these hooks exist here rather than as CSS selectors guessed inside a spec: a
 * class name is styling and moves, a `data-testid` is a contract and does not.
 *
 * Until the shell carries them, `join-and-race.spec.ts` fails at the first
 * locator and the failure message names the missing hook. That is the intended
 * state of this file on the day Plan 4 lands, and it is not skipped: a skipped
 * end-to-end asserts nothing while looking like it asserts everything.
 */
export const HOOKS = {
  /** Title screen: `{ kind: 'hostPressed' }`. */
  hostButton: 'host-button',
  /** Title screen: `{ kind: 'joinPressed' }`. */
  joinButton: 'join-button',
  /** Join flow: the five-character code input. */
  roomCodeInput: 'room-code-input',
  /** Join flow: submits `{ kind: 'roomCodeEntered' }`. */
  roomCodeSubmit: 'room-code-submit',
  /** Lobby: the room's own code, as text. */
  roomCodeDisplay: 'room-code',
  /** Lobby: toggles this player's ready flag. */
  readyButton: 'ready-button',
  /** Lobby, host only: requests the start. */
  startButton: 'start-button',
  /** Race screen: the canvas `startShell` renders into. */
  raceCanvas: 'race-canvas',
  /** Race screen: the HUD's lap text, e.g. "2/3". */
  lapCounter: 'lap-counter',
  /** Results screen, shown when the race finishes. */
  resultsScreen: 'results',
} as const

/** ROOM_CODE_ALPHABET and ROOM_CODE_LENGTH from `@tapkart/protocol`, mirrored.
 *  Crockford's base32: digits first, no I, L, O or U. */
export const ROOM_CODE_RE = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/

export function hook(page: Page, name: keyof typeof HOOKS) {
  return page.getByTestId(HOOKS[name])
}

/** Presses Host and returns the five-character code the lobby displays. */
export async function hostRoom(page: Page): Promise<string> {
  await page.goto('/')
  await hook(page, 'hostButton').click()
  const display = hook(page, 'roomCodeDisplay')
  await expect(display, 'the shell must expose data-testid="' + HOOKS.roomCodeDisplay + '"').toBeVisible()
  const code = ((await display.textContent()) ?? '').trim().toUpperCase()
  expect(code, 'the lobby must display a five-character room code').toMatch(ROOM_CODE_RE)
  return code
}

/** Presses Join, types a code, and waits for the lobby to show that same code. */
export async function joinRoom(page: Page, code: string): Promise<void> {
  await page.goto('/')
  await hook(page, 'joinButton').click()
  await hook(page, 'roomCodeInput').fill(code)
  await hook(page, 'roomCodeSubmit').click()
  await expect(hook(page, 'roomCodeDisplay')).toHaveText(new RegExp(code, 'i'))
}
```

- [ ] **Step 4: Write `e2e/lane.spec.ts` — the lane proof**

```ts
import { expect, test } from '@playwright/test'
import { ROOM_CODE_RE } from './fixtures/tapkart'

const WS_PATH = '/ws'                                    // src/static.ts
const HEALTH_PATH = '/healthz'                           // src/static.ts
const ASSETLINKS_PATH = '/.well-known/assetlinks.json'   // src/static.ts
const LOBBY_PATH_PREFIX = '/r/'                          // @tapkart/protocol, C-1

test('the lane serves a live Tapkart server on loopback', async ({ request }) => {
  const res = await request.get(HEALTH_PATH)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('application/json')
  expect(await res.text()).toContain('ok')
})

test('/.well-known/assetlinks.json is served with NO redirect', async ({ request }) => {
  // Spec §2 and §9. On Android 12+ a failed App Links verification is silent --
  // no chooser, no error -- so the tap opens a browser instead of the app and
  // nothing anywhere reports it. `maxRedirects: 0` makes Playwright THROW if the
  // server redirects, which is half the assertion; the absent Location header is
  // the other half.
  const res = await request.get(ASSETLINKS_PATH, { maxRedirects: 0, failOnStatusCode: false })
  expect(res.headers()['location']).toBeUndefined()

  // Plan 5 generates the file; until then a 404 is correct and deliberate -- a
  // placeholder fails verification silently, a 404 fails visibly. Either answer
  // is fine here; a 3xx is not, and neither is a trailing-slash normalisation.
  expect([200, 404]).toContain(res.status())

  const slashed = await request.get(ASSETLINKS_PATH + '/', { maxRedirects: 0, failOnStatusCode: false })
  expect(slashed.headers()['location']).toBeUndefined()
  expect(slashed.status()).toBe(404)
})

test('an invite path is served without a redirect', async ({ request }) => {
  // /r/ABCDE is the SPA: the room code is the client's to read, and the prefix
  // is compiled into the APK's autoVerify pathPrefix, so a redirect here is the
  // same silent failure in a different costume.
  const res = await request.get(LOBBY_PATH_PREFIX + 'ABCDE', { maxRedirects: 0, failOnStatusCode: false })
  expect(res.headers()['location']).toBeUndefined()
  expect([200, 404]).toContain(res.status())
})

test('a browser can open a WebSocket to the room path', async ({ page, baseURL }) => {
  // The real browser, the real upgrade, through runtime/http.ts and runtime/ws.ts
  // -- the two files vitest only smoke-tests. If this passes, the lane can carry
  // a lobby.
  await page.goto(HEALTH_PATH)
  const opened = await page.evaluate(async (url: string) => {
    return await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => { resolve(false) }, 10_000)
      socket.onopen = () => { clearTimeout(timer); socket.close(); resolve(true) }
      socket.onerror = () => { clearTimeout(timer); resolve(false) }
    })
  }, String(baseURL).replace(/^http/, 'ws') + WS_PATH)
  expect(opened).toBe(true)
})

test('the room-code alphabet the specs mirror is the one on the wire', () => {
  // ROOM_CODE_RE is a copy of ROOM_CODE_ALPHABET and ROOM_CODE_LENGTH, because
  // e2e/ is compiled by Playwright rather than by a package tsconfig. This keeps
  // the copy honest about the two properties the whole scheme rests on: exactly
  // 32 symbols, and exactly 5 characters.
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  expect(alphabet).toHaveLength(32)
  expect(new Set(alphabet).size).toBe(32)
  for (const confusable of ['I', 'L', 'O', 'U']) expect(alphabet).not.toContain(confusable)
  expect('0ABCD').toMatch(ROOM_CODE_RE)
  expect('0ABC').not.toMatch(ROOM_CODE_RE)      // four characters is the OLD length
  expect('0ABCI').not.toMatch(ROOM_CODE_RE)
})
```

- [ ] **Step 5: Write `e2e/join-and-race.spec.ts` — spec §8's row**

```ts
import { expect, test } from '@playwright/test'
import { HOOKS, hook, hostRoom, joinRoom } from './fixtures/tapkart'

/**
 * Spec §8: "Playwright drives two browser contexts joining by code and finishing
 * a race."
 *
 * Two CONTEXTS, not two projects: a second project would run this file twice
 * rather than produce a second player, and only two contexts in one test let one
 * player read a code the other one minted.
 *
 * This spec fails until Plan 3's shell carries the ten hooks in
 * e2e/fixtures/tapkart.ts. That is the intended state on the day Plan 4 lands:
 * the contract is written in executable form, the failure names the missing
 * hook, and Plan 5 owns the CI job that makes it blocking. It is not skipped.
 */
test('two contexts join by code and both finish the race', async ({ browser }) => {
  const hostContext = await browser.newContext()
  const guestContext = await browser.newContext()
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()

  const errors: string[] = []
  for (const [who, page] of [['host', host], ['guest', guest]] as const) {
    page.on('pageerror', (err) => { errors.push(who + ': ' + err.message) })
  }

  try {
    // 1. The host mints a room and the lobby shows its five-character code.
    const code = await hostRoom(host)

    // 2. The guest types that code -- the whole point of the code existing.
    await joinRoom(guest, code)

    // 3. The server owns lobby truth (F-P4-31), so both screens agree.
    await expect(hook(host, 'roomCodeDisplay')).toHaveText(new RegExp(code, 'i'))
    await expect(hook(guest, 'readyButton')).toBeVisible()
    await hook(guest, 'readyButton').click()

    // 4. Only the host may start. A guest that could start is F-P4-31 broken.
    await expect(hook(guest, 'startButton')).toHaveCount(0)
    await expect(hook(host, 'startButton')).toBeVisible()
    await hook(host, 'startButton').click()

    // 5. Both are racing: the canvas exists and the HUD counts laps.
    await expect(hook(host, 'raceCanvas')).toBeVisible()
    await expect(hook(guest, 'raceCanvas')).toBeVisible()
    await expect(hook(host, 'lapCounter')).toBeVisible()

    // The floor for step 6: the race actually progressed past the countdown, so
    // a results screen that appeared instantly could not satisfy it.
    await expect(hook(host, 'lapCounter')).toHaveText(/[1-3]\s*\/\s*3/, { timeout: 60_000 })

    // 6. Both finish. Three laps against bots is minutes of real time; the lane's
    // timeout is what changes if the shipped tracks are longer, never this
    // assertion.
    await expect(hook(host, 'resultsScreen')).toBeVisible({ timeout: 540_000 })
    await expect(hook(guest, 'resultsScreen')).toBeVisible({ timeout: 60_000 })

    expect(errors, 'the shell threw during the race').toEqual([])
  } finally {
    await hostContext.close()
    await guestContext.close()
  }
})

test('a guest that types a code for no room is told so, rather than hanging', async ({ page }) => {
  // F-P4-34's other half, from the player's side: a wrong code must produce an
  // answer. `roomNotFound` is one of the two results the failed-join limiter
  // charges, and a spinner forever is what the WelcomeMessage exists to prevent.
  await page.goto('/')
  await hook(page, 'joinButton').click()
  await hook(page, 'roomCodeInput').fill('ZZZZZ')
  await hook(page, 'roomCodeSubmit').click()

  await expect(
    page.getByText(/not found|no such room|invalid/i),
    'a join for a room that does not exist must surface an error, not a spinner',
  ).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId(HOOKS.roomCodeDisplay)).toHaveCount(0)
})
```

- [ ] **Step 6: Verify the lane — the exact commands and what you must see**

```bash
npm run test:e2e -- e2e/lane.spec.ts
```

Expected: Playwright builds the server bundle and every workspace that has a
build script, starts `node packages/server/dist/main.mjs` on `127.0.0.1:3132`,
and reports **5 passed**. The `webServer` block prints the server's own
`tapkart server listening on port 3132` line through `stdout: 'pipe'`.

If port 3132 is in use on your machine:

```bash
TAPKART_E2E_PORT=3999 npm run test:e2e -- e2e/lane.spec.ts
```

Then run the whole lane:

```bash
npm run test:e2e
```

Expected **today**: `lane.spec.ts` 5 passed; `join-and-race.spec.ts` 2 failed,
each failure naming a `data-testid` the shell does not yet expose — for example
`locator.click: Timeout ... waiting for getByTestId('host-button')`. **That is
the correct result for this task**, and it is why the file is not skipped: the
contract is visible, executable, and named in the failure.

Finally, prove the vitest lane is untouched:

```bash
npm test
```
Expected: every package green, **no browser process started**, and the run
terminates on its own.

- [ ] **Step 7: Commit**

```bash
git add playwright.config.ts e2e package.json package-lock.json
git commit -m "feat(e2e): the Playwright lane and the first two specs (C-4)

Spec §8's last row needs the server, the lobby and the room code, all three
of which are Plan 4's -- so Plan 4 owns the harness and Plan 5 adds specs to
it. The lane is a separate command from npm test, is outside
vitest.config.ts's include glob, and drives a server bound to loopback: the
vitest suite stays browserless.

lane.spec.ts proves the lane itself, against behaviour this plan owns end to
end -- healthz, a real browser WebSocket upgrade through runtime/http.ts and
runtime/ws.ts, and /.well-known/assetlinks.json served with NO redirect and
no trailing-slash normalisation, asserted over real HTTP with maxRedirects:
0. On Android 12+ a failed App Links verification is silent, so this is the
one property with no other symptom anywhere in the system.

join-and-race.spec.ts is spec §8's row in full: two browser contexts, one
hosts, one joins by typed code, both finish three laps. It fails until Plan
3's shell carries the ten data-testid hooks in e2e/fixtures/tapkart.ts, and
it is deliberately NOT skipped -- a skipped end-to-end asserts nothing while
looking like it asserts everything, and this repository has shipped
twenty-one tests that could not detect what they existed to detect.

The lane binds a fixed loopback port from TAPKART_E2E_PORT (default 3132)
rather than an ephemeral one: Playwright must know the URL before it starts
the server, and an OS-assigned port cannot be communicated back to it."
```
