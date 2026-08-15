### Task 18: the platform adapters, the lobby's invite panel, and the app's composition root

**Files:**
- Create: `apps/web/src/platform/env.ts` — contract §10.1, ADAPTER
- Create: `apps/web/src/platform/nfc.ts` — contract §10.2, ADAPTER
- Create: `apps/web/src/platform/audio.ts` — contract §9.4, ADAPTER
- Modify: `apps/web/src/main.ts` — SW registration, install/update wiring, the audio gate, `NfcHost` selection, `origin` (§15.2)
- Modify: `apps/web/package.json` — dependency on `@tapkart/invite` and `@capacitor/core`
- Modify: `packages/game/package.json` — dependency on `@tapkart/invite` (R39; P5 Q4 makes it unconditional)
- Modify: `packages/game/src/shell.ts` — `ShellOptions.nfc?` and `ShellOptions.origin?` (§2.3), and the lobby's invite panel
- Modify: `package-lock.json` — the `npm install` side effect
- Test: `apps/web/test/platform.test.ts`

**Ordering:** after **Task 15** (the update and install reducers), **Task 16** (the service worker it registers) and **Task 17** (`createWebAudioBackend`). It also needs Tasks 3, 6 and 9 for `buildInviteUri`, `parseInviteUri`, `nullNfcHost` and `buildQrMatrix`.

**Interfaces:**

- **Consumes** — `packages/invite`, from Tasks 3, 6 and 9:

  ```ts
  export interface InviteUri { origin: string; roomCode: string }
  export function buildInviteUri(origin: string, roomCode: string): string
  export function parseInviteUri(uri: string): InviteUri | null

  export interface NfcSupport { hardware: boolean; hce: boolean; adapterEnabled: boolean }
  export type InviteSource = 'tag' | 'appLink'
  export interface NfcHost {
    supported(): Promise<NfcSupport>
    advertise(uri: string): Promise<void>
    stop(): Promise<void>
    onInvite(cb: (uri: string, source: InviteSource) => void): () => void
    pendingInvite(): Promise<string | null>
  }
  export const nullNfcHost: NfcHost

  export interface QrMatrix { size: number; modules: Uint8Array }
  export const QR_QUIET_ZONE = 4
  export function buildQrMatrix(text: string): QrMatrix
  export function qrModuleAt(m: QrMatrix, x: number, y: number): boolean
  ```

- **Consumes** — Task 3's pure origin choice, and Task 15's two reducers:

  ```ts
  export function chooseOrigin(isNative: boolean, buildOrigin: string, locationOrigin: string): string

  export interface UpdateState { waiting: boolean; applying: boolean; deferred: boolean }
  export function createUpdateState(): UpdateState
  export function reduceUpdate(prev: UpdateState, ev: UpdateEvent): UpdateState

  export interface InstallState { available: boolean; installed: boolean; dismissedAtMs: number }
  export const INSTALL_DISMISS_COOLDOWN_MS: number
  export function createInstallState(): InstallState
  export function reduceInstall(prev: InstallState, ev: InstallEvent): InstallState
  ```

- **Consumes** — Task 17's adapter, and Plan 3's seam:

  ```ts
  export function createWebAudioBackend(context: AudioContext, initial: Readonly<AudioConfig>): AudioBackend
  export interface AudioConfig { masterGain: number; enabled: boolean }
  export const nullAudioBackend: AudioBackend
  ```

- **Consumes** — Plan 3's shipped shell and screen model, quoted:

  ```ts
  export interface ShellOptions {
    canvas: HTMLCanvasElement
    root: HTMLElement
    clock: FrameClock
    store: KeyValueStore
    renderer: RendererBackend
    audio: AudioBackend
  }
  export interface GameShell { stop(): void }
  export function startShell(opts: ShellOptions): GameShell

  export type ScreenId = 'title' | 'characterSelect' | 'lobby' | 'race' | 'results'
  export type AppEvent =
    | { kind: 'roomCodeEntered'; code: string }
    | { kind: 'raceStarting' }
    | { kind: 'raceFinished'; results: ResultRow[] }
    // … the other twelve, unchanged …
  export const realFrameClock: FrameClock
  ```

  and `LOBBY_PATH_PREFIX`, `isValidRoomCode` from `@tapkart/protocol`.

- **Produces** — §16's census: **3** exports from `platform/env`, **2** from `platform/nfc`, **2** from `platform/audio`, and **two optional fields** added to Plan 3's `ShellOptions`, which are not new exported symbols.

  ```ts
  // platform/env.ts
  export const BUILD_ORIGIN: string
  export const IS_NATIVE: boolean
  export function appOrigin(): string

  // platform/nfc.ts
  export interface TapkartNfcPluginBridge { /* §10.2, mirrors §7.4 exactly */ }
  export function capacitorNfcHost(): NfcHost

  // platform/audio.ts
  export interface AudioGate { context: AudioContext | null; dispose(): void }
  export function installAudioGate(onReady: (ctx: AudioContext) => void): AudioGate
  ```

**Almost none of this is testable, and saying so is the point.** Plan 3 §8.2 already drew the line and §0a extends it: an adapter is *"the thin layer handing plain data to a real device API. No branching on game state, no arithmetic beyond unit conversion… A conditional in an adapter is a contract violation, because it is a decision CI cannot see."*

So the decisions were all made elsewhere, deliberately:

| The decision | Where it lives | Who tests it |
|---|---|---|
| What origin an invite URI is built from | `chooseOrigin` (pure) | Task 3, four cases including the native-without-origin throw |
| Whether a request is cached | `routeRequest` (pure) | Task 15, every row and every ordering pair |
| Whether an update may apply | `reduceUpdate` (pure) | Task 15 |
| Whether to offer installation | `reduceInstall` (pure) + one caller expression | Task 15 |
| What sound to make | `planAudio` (pure) | Task 17 |
| What the tag says | `buildInviteUri` (pure) | Task 3 |

What is left in this task is wiring, and the honest verification for wiring is a typecheck, a build, and a human with a phone. The **one** thing here that is both mechanical and worth asserting is that **the browser build never registers a Capacitor plugin** — that is a real branch with a real consequence (a `registerPlugin` call in a plain browser produces a proxy whose every method rejects, and a lobby that awaits one hangs), and `IS_NATIVE` is false under vitest by construction.

**What CI cannot verify here** (§14, and every row is in `docs/owner-verification.md`): that the QR scans — *"a camera, a screen, and lighting"*; that the install prompt appears — *"Chrome's engagement heuristics"*; that the audio gate fires on a real touch; that a cold-start App Link lands in the lobby rather than the title screen (items 8 and 12).

---

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/platform.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { nullNfcHost } from '@tapkart/invite'
import { appOrigin, BUILD_ORIGIN, IS_NATIVE } from '../src/platform/env'
import { capacitorNfcHost } from '../src/platform/nfc'

describe('platform/env — the single permitted platform check (§10.1)', () => {
  it('is not native under a headless run, because there is no Capacitor bridge', () => {
    expect(IS_NATIVE).toBe(false)
  })

  it('has an empty build origin when VITE_TAPKART_ORIGIN is unset', () => {
    // "Only the APK build sets it (§3.1); a browser build leaves it empty and
    // nothing breaks."
    expect(BUILD_ORIGIN).toBe('')
  })

  it('never carries a trailing slash, whatever the variable said', () => {
    expect(BUILD_ORIGIN.endsWith('/')).toBe(false)
  })

  it('returns a string and does not throw where there is no location', () => {
    expect(typeof appOrigin()).toBe('string')
  })
})

describe('platform/nfc — the browser build registers no plugin (§10.2)', () => {
  /** A registerPlugin call in a plain browser yields a proxy whose every method
   *  rejects. A lobby that awaits `advertise()` on one hangs with no error the
   *  player can see, which is why this branch is worth an assertion even though
   *  the rest of the adapter is not testable at all. */
  it('returns nullNfcHost when not native', () => {
    expect(capacitorNfcHost()).toBe(nullNfcHost)
  })

  it('reports no NFC support at all, and resolves rather than rejecting', async () => {
    await expect(capacitorNfcHost().supported()).resolves.toEqual({
      hardware: false,
      hce: false,
      adapterEnabled: false,
    })
  })

  it('resolves a null pending invite instead of hanging', async () => {
    await expect(capacitorNfcHost().pendingInvite()).resolves.toBeNull()
  })

  it('advertise and stop resolve, so the lobby never awaits forever in a browser', async () => {
    const host = capacitorNfcHost()
    await expect(host.advertise('https://tapkart.example/r/ABCDE')).resolves.toBeUndefined()
    await expect(host.stop()).resolves.toBeUndefined()
  })

  it('onInvite returns an unsubscribe that can be called safely', () => {
    const off = capacitorNfcHost().onInvite(() => undefined)
    expect(typeof off).toBe('function')
    expect(() => off()).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/web/test/platform.test.ts`

Expected: **FAIL at collect time**:

```
Error: Failed to resolve import "../src/platform/env" from "apps/web/test/platform.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

**3a.** Add the two dependencies. `@capacitor/core` is pinned to whatever major Task 13 recorded in `apps/android/package.json`, read rather than typed, so the app and the APK can never be built against two Capacitor majors:

```bash
cap_core="$(node -e "const p=require('./apps/android/package.json');process.stdout.write(p.dependencies['@capacitor/core'])")"
npm install -w @tapkart/web "@capacitor/core@$cap_core"
npm pkg set 'dependencies.@tapkart/invite=*' -w @tapkart/web
npm pkg set 'dependencies.@tapkart/invite=*' -w @tapkart/game
npm install
```

`packages/game` gains `@tapkart/invite` unconditionally (R39, P5 Q4). `invite` depends only on `protocol`, so the graph stays acyclic and `game` remains a leaf nothing depends on.

**3b.** Create `apps/web/src/platform/env.ts`:

```ts
// ADAPTER. Contract §10.1. It contains no decision: the one branch that decides
// what every invite URI in the product says is `chooseOrigin`, which is pure and
// lives in src/pwa/origin.ts (§10.3, §0a).

import { chooseOrigin, stripTrailingSlash } from '../pwa/origin'

/** The deployed origin baked in at build time, trailing slash stripped, or ''
 *  when unset. Only the APK build sets it (§3.1); a browser build leaves it
 *  empty and nothing breaks. */
export const BUILD_ORIGIN: string = stripTrailingSlash(
  (import.meta.env.VITE_TAPKART_ORIGIN ?? '').trim(),
)

/** True inside the Capacitor WebView. One expression, one global read; this is
 *  the single permitted platform check in the whole app.
 *
 *  The bridge injects `window.Capacitor` before any application script runs, so
 *  reading it at module load is safe and is the cheapest form of the check. */
export const IS_NATIVE: boolean =
  (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
    ?.isNativePlatform?.() === true

/** chooseOrigin(IS_NATIVE, BUILD_ORIGIN, location.origin). Every invite URI and
 *  every QR payload in the app comes from here.
 *
 *  `location` is read through globalThis so this module can be imported by a
 *  headless test without a DOM; in every browser and every WebView it is there,
 *  and in the native case chooseOrigin ignores it entirely. */
export function appOrigin(): string {
  const loc = (globalThis as { location?: { origin?: string } }).location
  return chooseOrigin(IS_NATIVE, BUILD_ORIGIN, loc?.origin ?? '')
}
```

**3c.** Create `apps/web/src/platform/nfc.ts`:

```ts
// ADAPTER. Contract §10.2. The only registerPlugin call in the repository, and
// it contains no decisions beyond the one platform check.

import { registerPlugin } from '@capacitor/core'
import { nullNfcHost, type InviteSource, type NfcHost, type NfcSupport } from '@tapkart/invite'
import { IS_NATIVE } from './env'

/** The Capacitor bridge's shape, declared here rather than imported, so the
 *  plugin's TS surface and the Kotlin @PluginMethod list are compared by review
 *  against one written-down thing. Mirrors §7.4 exactly. */
export interface TapkartNfcPluginBridge {
  isSupported(): Promise<NfcSupport>
  startAdvertising(options: { uri: string }): Promise<void>
  stopAdvertising(): Promise<void>
  startReader(): Promise<void>
  stopReader(): Promise<void>
  getPendingInvite(): Promise<{ uri: string | null }>
  addListener(
    eventName: 'inviteUri',
    cb: (ev: { uri: string; source: InviteSource }) => void,
  ): Promise<{ remove(): Promise<void> }>
}

/** Returns the Capacitor-backed NfcHost when IS_NATIVE, `nullNfcHost` otherwise.
 *  The only `registerPlugin` call in the repository. Contains no decisions
 *  beyond that one platform check. */
export function capacitorNfcHost(): NfcHost {
  if (!IS_NATIVE) return nullNfcHost

  const plugin = registerPlugin<TapkartNfcPluginBridge>('TapkartNfc')

  return {
    supported(): Promise<NfcSupport> {
      return plugin.isSupported()
    },
    advertise(uri: string): Promise<void> {
      // Reader mode and advertising are both idempotent on the Kotlin side, so
      // this adapter never tracks whether it already started (§7.4).
      return plugin.startAdvertising({ uri })
    },
    stop(): Promise<void> {
      return plugin.stopAdvertising()
    },
    onInvite(cb: (uri: string, source: InviteSource) => void): () => void {
      // F-P5-16: both entry points, one callback. Two callbacks would be two
      // paths, which is the objection the ruling overruled.
      const handle = plugin.addListener('inviteUri', (ev) => cb(ev.uri, ev.source))
      return () => {
        void handle.then((h) => h.remove())
      }
    },
    async pendingInvite(): Promise<string | null> {
      const { uri } = await plugin.getPendingInvite()
      return uri
    },
  }
}
```

**3d.** Create `apps/web/src/platform/audio.ts`:

```ts
// ADAPTER. Contract §9.4. The ONLY place in the repository that constructs an
// AudioContext (§13).

export interface AudioGate {
  context: AudioContext | null
  dispose(): void
}

/** Attaches a one-shot pointerdown/keydown listener, constructs and resumes the
 *  AudioContext inside that gesture, then calls back.
 *
 *  Every mobile browser refuses to start an AudioContext outside a user gesture,
 *  and a context created at load sits `suspended` FOREVER with no error — there
 *  is no event, no rejected promise and nothing in the console. Until the gate
 *  fires, apps/web passes `nullAudioBackend`, which is Plan 3's shipped default
 *  and needs no new branch anywhere. */
export function installAudioGate(onReady: (ctx: AudioContext) => void): AudioGate {
  const gate: AudioGate = {
    context: null,
    dispose(): void {
      window.removeEventListener('pointerdown', fire)
      window.removeEventListener('keydown', fire)
    },
  }

  function fire(): void {
    gate.dispose()
    if (gate.context !== null) return
    if (typeof AudioContext === 'undefined') return
    const ctx = new AudioContext()
    gate.context = ctx
    // resume() inside the gesture: on iOS a context constructed in a gesture is
    // still 'suspended' until this call, and the call must happen in the same
    // task as the gesture.
    void ctx.resume().then(() => onReady(ctx))
  }

  window.addEventListener('pointerdown', fire, { once: true })
  window.addEventListener('keydown', fire, { once: true })
  return gate
}
```

**3e.** Replace `apps/web/src/main.ts`. Plan 3's Task 23 shipped it as *"the entry module. It calls startShell and nothing else"*; §15.2 gives Plan 5 five additions to it, and this is the whole file after them:

```ts
// The entry module. It calls startShell and nothing else — every decision lives
// behind that call, in packages/game — plus the five platform wirings §15.2
// assigns to Plan 5: the service worker, the update and install flows, the audio
// gate, the NfcHost, and the origin.
import { parseInviteUri, type InviteSource, type NfcHost } from '@tapkart/invite'
import { realFrameClock } from '@tapkart/game'
import { startShell } from '@tapkart/game/shell'
import { nullAudioBackend } from '@tapkart/render'
import { DEFAULT_THREE_OPTIONS, createThreeRenderer } from '@tapkart/render/three'
import { createWebAudioBackend } from '@tapkart/render/web-audio'
import { createInstallState, INSTALL_DISMISS_COOLDOWN_MS, reduceInstall } from './pwa/install'
import { createUpdateState, reduceUpdate } from './pwa/update'
import { appOrigin } from './platform/env'
import { capacitorNfcHost } from './platform/nfc'
import { installAudioGate } from './platform/audio'

const canvas = document.getElementById('tk-canvas')
const root = document.getElementById('tk-root')
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('main: #tk-canvas is missing from index.html')
if (!(root instanceof HTMLElement)) throw new Error('main: #tk-root is missing from index.html')

// localStorage throws outright in some privacy modes, so both halves are
// guarded. Losing settings is a worse-but-playable game; a thrown exception here
// is a black screen.
const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      // Storage denied: the session still plays, it just does not persist.
    }
  },
}

/* ------------------------------------------------------------- the NfcHost */

const platformNfc = capacitorNfcHost()

/** The platform host, with one addition the platform cannot make: in a BROWSER
 *  the invite arrives in the address bar, not through a plugin. `capacitorNfcHost`
 *  may not know that (§10.2: "contains no decisions beyond that one platform
 *  check"), so the composition root adds it here, using the shipped parser. */
const nfc: NfcHost = {
  supported: () => platformNfc.supported(),
  advertise: (uri: string) => platformNfc.advertise(uri),
  stop: () => platformNfc.stop(),
  onInvite: (cb: (uri: string, source: InviteSource) => void) => platformNfc.onInvite(cb),
  async pendingInvite(): Promise<string | null> {
    const fromPlatform = await platformNfc.pendingInvite()
    if (fromPlatform !== null) return fromPlatform
    const href = window.location.href
    return parseInviteUri(href) === null ? null : href
  },
}

/* ------------------------------------------------------------- the shell */

const shell = startShell({
  canvas,
  root,
  clock: realFrameClock,
  store,
  renderer: createThreeRenderer(canvas, DEFAULT_THREE_OPTIONS),
  audio: nullAudioBackend, // until the gesture gate fires (§9.4)
  nfc,
  origin: appOrigin(),
})

/* ------------------------------------------------------------- the audio gate */

// The context can only be built inside a user gesture, so the real backend
// replaces the null one on the first touch or key press. `startShell` holds the
// backend it was given, so the swap is a `stop()`-free restart of nothing: the
// shell reads `opts.audio` once, and the gate hands the new backend to it
// through the same field on the next frame it is read.
const gate = installAudioGate((ctx) => {
  shell.setAudio(createWebAudioBackend(ctx, { masterGain: 1, enabled: true }))
})

/* ------------------------------------------------------------- the service worker */

let updateState = createUpdateState()
let installState = createInstallState()

const DISMISSED_AT_KEY = 'tapkart.install.dismissedAt.v1'
const storedDismissal = Number(store.get(DISMISSED_AT_KEY) ?? '0')
if (Number.isFinite(storedDismissal) && storedDismissal > 0) {
  installState = { ...installState, dismissedAtMs: storedDismissal }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').then((registration) => {
      const noteWaiting = (): void => {
        if (registration.waiting === null) return
        updateState = reduceUpdate(updateState, { kind: 'workerWaiting' })
        offerUpdateIfAllowed(registration)
      }
      noteWaiting()
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        if (installing === null) return
        installing.addEventListener('statechange', noteWaiting)
      })
    })

    // The page reloads once, when the new worker takes control (P5 Q25).
    let reloading = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return
      reloading = true
      window.location.reload()
    })
  })
}

function offerUpdateIfAllowed(registration: ServiceWorkerRegistration): void {
  // The caller predicate §8.5 names: waiting, not applying, not deferred.
  if (!updateState.waiting || updateState.applying || updateState.deferred) return
  const accepted = window.confirm('A new version of Tapkart is ready. Reload now?')
  updateState = reduceUpdate(updateState, { kind: accepted ? 'userAccepted' : 'userDismissed' })
  if (updateState.applying) registration.waiting?.postMessage({ type: 'SKIP_WAITING' })
}

/* ------------------------------------------------------------- install prompt */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null

window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault()
  deferredPrompt = ev as BeforeInstallPromptEvent
  installState = reduceInstall(installState, { kind: 'promptAvailable' })
})

window.addEventListener('appinstalled', () => {
  deferredPrompt = null
  installState = reduceInstall(installState, { kind: 'installed' })
})

/** Called by the shell when the player reaches the results screen — the one
 *  moment the game is idle and the player is not mid-decision. iOS has no
 *  `beforeinstallprompt` at all; `available` simply stays false there and no
 *  instructional UI ships in v1. */
function maybeOfferInstall(nowMs: number): void {
  const cool = nowMs - installState.dismissedAtMs >= INSTALL_DISMISS_COOLDOWN_MS
  if (!installState.available || installState.installed || !cool) return
  const prompt = deferredPrompt
  if (prompt === null) return
  installState = reduceInstall(installState, { kind: 'promptShown' })
  void prompt.prompt().catch(() => {
    installState = reduceInstall(installState, { kind: 'dismissed', nowMs })
    store.set(DISMISSED_AT_KEY, String(nowMs))
  })
}

shell.onIdle(() => maybeOfferInstall(Date.now()))

// A race in progress blocks an update landing (P5 Q25).
shell.onRaceStateChange((racing: boolean) => {
  updateState = reduceUpdate(updateState, { kind: racing ? 'raceStarted' : 'raceEnded' })
})

// `pagehide` fires on mobile Safari where `beforeunload` does not.
window.addEventListener('pagehide', () => {
  gate.dispose()
  shell.stop()
})
```

**3f.** In `packages/game/src/shell.ts`, add the two optional `ShellOptions` fields R39 licenses by name, and the three `GameShell` methods `main.ts` calls above. Keep everything Plan 3 put in the file:

```ts
import {
  buildInviteUri,
  buildQrMatrix,
  nullNfcHost,
  parseInviteUri,
  qrModuleAt,
  QR_QUIET_ZONE,
  type NfcHost,
} from '@tapkart/invite'

export interface ShellOptions {
  // … the six Plan 3 fields, unchanged …

  /** The platform's invite surface: HCE advertising, reader mode, and the URI a
   *  launch intent carried. Optional so every Plan 3 call site still compiles;
   *  `startShell` substitutes `nullNfcHost` when absent, exactly as `audio`
   *  takes `nullAudioBackend`. */
  nfc?: NfcHost

  /** The origin invite URIs are built from (C-3). Optional; defaults to
   *  `location.origin`. `apps/web` computes it with `chooseOrigin` (§10.3) and
   *  passes the result in, because the APP knows whether it is running in a
   *  browser or in a WebView and the GAME must not contain that check. */
  origin?: string
}

export interface GameShell {
  stop(): void
  /** Swaps the AudioBackend. The gesture gate (§9.4) cannot run before
   *  composition, so the shell starts with `nullAudioBackend` and receives the
   *  real one on the first touch. Calls `close()` on the outgoing backend. */
  setAudio(next: AudioBackend): void
  /** Fires when the player reaches a screen where nothing is running — the
   *  results and title screens. `apps/web` uses it for the install prompt. */
  onIdle(cb: () => void): void
  /** Fires with `true` when a race starts and `false` when it ends, so an
   *  update never activates over a live authority loop (P5 Q25). */
  onRaceStateChange(cb: (racing: boolean) => void): void
}
```

Inside `startShell`, resolve the two new options once, next to where `opts.audio` is read:

```ts
  const nfc: NfcHost = opts.nfc ?? nullNfcHost
  const origin: string = opts.origin ?? window.location.origin
```

Then add the invite panel. It is a private function in this file — §16's census is unchanged and §15.1 does not list a new `packages/game` module:

```ts
/** The lobby's invite surface: the tap prompt, the QR and the room code, all
 *  visible at once.
 *
 *  Spec §2 requires all three together — "QR and a … room code are always
 *  displayed alongside… Nobody is ever blocked from joining" — and
 *  `docs/owner-verification.md` item 3 is the human check that they are. A tap
 *  that fails must cost the guest a QR scan, not the race.
 *
 *  Returns a disposer. */
function mountInvitePanel(
  host: HTMLElement,
  args: { origin: string; roomCode: string; nfc: NfcHost },
): () => void {
  const panel = document.createElement('div')
  panel.setAttribute('data-testid', 'invite-panel')

  const uri = buildInviteUri(args.origin, args.roomCode)

  const tap = document.createElement('p')
  tap.setAttribute('data-testid', 'invite-tap')
  tap.textContent = 'Hold another phone against the back of this one to join.'
  panel.appendChild(tap)

  const qr = document.createElement('canvas')
  qr.setAttribute('data-testid', 'invite-qr')
  panel.appendChild(qr)
  drawQr(qr, uri)

  host.appendChild(panel)

  // Advertising is idempotent (§4.6), so this is safe to call on every lobby
  // entry without tracking whether it already started.
  void args.nfc.advertise(uri).catch(() => {
    // A phone with no NFC, or NFC switched off. The QR and the code are still on
    // screen, so nothing is blocked and a modal here would be noise. §6.4 rule 5
    // makes the same choice on the Kotlin side for an unreadable tag.
    tap.textContent = 'Scan the code or type it in to join.'
  })

  return () => {
    void args.nfc.stop()
    panel.remove()
  }
}

/** Black on white with a quiet zone, always — never themed.
 *
 *  A dark-mode QR with light modules on a dark field fails to scan on a large
 *  fraction of phone cameras, and it fails silently: the guest just points at it
 *  and nothing happens. The quiet zone is part of the symbol, not padding. */
function drawQr(canvas: HTMLCanvasElement, text: string): void {
  const matrix = buildQrMatrix(text)
  const modules = matrix.size + QR_QUIET_ZONE * 2
  const scale = Math.max(2, Math.floor(320 / modules))
  canvas.width = modules * scale
  canvas.height = modules * scale
  canvas.style.width = `${modules * scale}px`
  canvas.style.height = `${modules * scale}px`
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#000000'
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (!qrModuleAt(matrix, x, y)) continue
      ctx.fillRect((x + QR_QUIET_ZONE) * scale, (y + QR_QUIET_ZONE) * scale, scale, scale)
    }
  }
}
```

Call it where the lobby screen mounts, passing the element that already holds Plan 3's `room-code` node, and call the disposer when the screen changes away from `'lobby'`. **Do not move, rename or replace the `room-code` element** — it is one of the eleven cross-plan `data-testid` hooks, and *"a testid that does not match is the same silent failure as a mismatched CSS selector"*.

**The eleventh hook already lands with Plan 3 and is verified here.** The title screen's solo control — the one that dispatches `{ kind: 'soloPressed' }` (Plan 3 §5.9) — already carries `data-testid="solo-button"`, beside `host-button` and `join-button`:

```ts
  soloButton.setAttribute('data-testid', 'solo-button')
```

Plan 3 §5.13's corrected table is eleven names that *must not be renamed*. Do not add a second attribute or reach into the shell's internal button from `apps/web`; assert the existing spelling. F-P5-26's offline spec (Task 20) drives a solo race with the network off, and solo is the only path that can run with no server — so without this hook, **the one requirement that gates the build has no way to be checked at all.**

Finally, wire the guest side once, where the shell starts:

```ts
  // Both entry points, one handler (F-P5-16). A URI that does not parse is
  // dropped silently — §6.4 rule 5: "The guest's phone will be tapped against
  // transit cards and hotel keys; a modal error for each is worse than nothing
  // happening."
  const offInvite = nfc.onInvite((uri) => {
    const invite = parseInviteUri(uri)
    if (invite === null) return
    dispatch({ kind: 'roomCodeEntered', code: invite.roomCode })
  })

  // A cold-start App Link is delivered before any JavaScript has run, so
  // `onInvite` cannot have been registered yet and the invite is silently lost
  // without this. That is a tap that does nothing — the exact failure mode this
  // plan is written to prevent.
  void nfc.pendingInvite().then((uri) => {
    if (uri === null) return
    const invite = parseInviteUri(uri)
    if (invite === null) return
    dispatch({ kind: 'roomCodeEntered', code: invite.roomCode })
  })
```

and call `offInvite()` from `stop()`, beside whatever Plan 3 already tears down there.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run apps/web/test/platform.test.ts
npm run typecheck -w @tapkart/web
npm run typecheck -w @tapkart/game
npm run build -w @tapkart/web
npx vitest run
```

Expected: **9 passed** in `platform.test.ts` (4 env + 5 nfc), no typecheck output from either package, a clean build, and the whole suite green.

If `@tapkart/invite` does not resolve from `packages/game`, Step 3a's `npm pkg set` did not run or `npm install` was skipped — fix it there, never with a relative path into another package.

If importing `@capacitor/core` fails under `environment: 'node'`, delete the five `platform/nfc` tests and rely on the typecheck and item 5 of the owner checklist. **Do not add jsdom** and do not add a per-file `@vitest-environment` override: contract §0 forbids both outright, in any file Plan 5 writes.

Then confirm the dependency direction did not invert, because `game` gaining a dependency is the one structural change in this task:

Run: `node -e "const g=require('./packages/game/package.json');const i=require('./packages/invite/package.json');if(!g.dependencies['@tapkart/invite'])throw new Error('game does not depend on invite');if(i.dependencies['@tapkart/game'])throw new Error('invite depends on game — the graph has a cycle');console.log('acyclic')"`
Expected: `acyclic`.

Then run the app and look at the lobby, because the invite panel is DOM and nothing in vitest renders DOM:

Run: `npm run dev -w @tapkart/web`, open the app, press Host.
Expected: the room code, a black-on-white QR with a visible white margin, and the tap prompt, **all three on screen at once**. Scan the QR with a second phone's camera and confirm it opens `https://<your dev origin>/r/<the code on screen>` — the two halves of §3 agreeing, checked by eye because nothing else can check it.

**What that did not prove**, and it is why `docs/owner-verification.md` exists: that the tap works (items 4 to 8), that a cold start lands in the lobby (item 8), that the install prompt ever appears (Chrome's engagement heuristics), or that the audio gate fires on a real touch (item 14).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/platform apps/web/src/main.ts apps/web/package.json apps/web/test/platform.test.ts packages/game/package.json packages/game/src/shell.ts package-lock.json && git commit -m "feat(web,game): platform adapters, the lobby invite panel, and the app's composition root (§9.4, §10, §2.3)"
```
