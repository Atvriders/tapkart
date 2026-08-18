// The composition root: game decisions stay in packages/game while browser,
// PWA, audio and Capacitor lifecycles meet here.
import { parseInviteUri, type InviteSource, type NfcHost } from '@tapkart/invite'
import { realFrameClock } from '@tapkart/game'
import { startShell } from '@tapkart/game/shell'
import { nullAudioBackend } from '@tapkart/render'
import { DEFAULT_THREE_OPTIONS, createThreeRenderer } from '@tapkart/render/three'
import { createWebAudioBackend } from '@tapkart/render/web-audio'
import {
  createInstallState,
  INSTALL_DISMISS_COOLDOWN_MS,
  reduceInstall,
} from './pwa/install'
import { createUpdateState, reduceUpdate } from './pwa/update'
import { installAudioGate } from './platform/audio'
import { appOrigin } from './platform/env'
import { capacitorNfcHost } from './platform/nfc'
import { installPageLifecycle } from './platform/page-lifecycle'

const canvasNode = document.getElementById('tk-canvas')
const rootNode = document.getElementById('tk-root')
if (!(canvasNode instanceof HTMLCanvasElement)) {
  throw new Error('main: #tk-canvas is missing from index.html')
}
if (!(rootNode instanceof HTMLElement)) throw new Error('main: #tk-root is missing from index.html')
// Capture the narrowed values outside the restartable closure. TypeScript does
// not retain DOM lookup narrowing across a callback invoked by another module.
const canvas: HTMLCanvasElement = canvasNode
const root: HTMLElement = rootNode

// localStorage throws outright in some privacy modes. Losing persistence is a
// playable degradation; throwing here would leave a black screen.
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
      // Storage denied: retain settings only for this session.
    }
  },
}

/* ------------------------------------------------------------- the NfcHost */

const platformNfc = capacitorNfcHost()
const nfc: NfcHost = {
  supported: () => platformNfc.supported(),
  advertise: (uri: string) => platformNfc.advertise(uri),
  stop: () => platformNfc.stop(),
  startReader: () => platformNfc.startReader(),
  stopReader: () => platformNfc.stopReader(),
  onInvite: (cb: (uri: string, source: InviteSource) => void) => platformNfc.onInvite(cb),
  async pendingInvite(): Promise<string | null> {
    const fromPlatform = await platformNfc.pendingInvite()
    if (fromPlatform !== null) return fromPlatform
    const href = window.location.href
    return parseInviteUri(href) === null ? null : href
  },
}

/* ------------------------------------------------------------- PWA state */

let updateState = createUpdateState()
let installState = createInstallState()
let waitingRegistration: ServiceWorkerRegistration | null = null

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
        // Retain the registration: a dismissal or an in-race discovery must be
        // offered again after a later raceEnded transition.
        waitingRegistration = registration
        updateState = reduceUpdate(updateState, { kind: 'workerWaiting' })
        offerUpdateIfAllowed(waitingRegistration)
      }
      noteWaiting()
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        if (installing === null) return
        installing.addEventListener('statechange', noteWaiting)
      })
    }).catch(() => {
      // Offline/PWA support is an enhancement to an otherwise playable page.
      // Private modes and enterprise policies may reject registration; do not
      // turn that recoverable platform decision into an unhandled page error.
    })

    let reloading = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return
      reloading = true
      window.location.reload()
    })
  })
}

function offerUpdateIfAllowed(registration: ServiceWorkerRegistration): void {
  if (!updateState.waiting || updateState.applying || updateState.deferred) return
  const accepted = window.confirm('A new version of Tapkart is ready. Reload now?')
  updateState = reduceUpdate(updateState, {
    kind: accepted ? 'userAccepted' : 'userDismissed',
  })
  if (updateState.applying) registration.waiting?.postMessage({ type: 'SKIP_WAITING' })
}

/* ------------------------------------------------------------- install prompt */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault()
  deferredPrompt = event as BeforeInstallPromptEvent
  installState = reduceInstall(installState, { kind: 'promptAvailable' })
})

window.addEventListener('appinstalled', () => {
  deferredPrompt = null
  installState = reduceInstall(installState, { kind: 'installed' })
})

async function maybeOfferInstall(nowMs: number): Promise<void> {
  const cooldownElapsed =
    nowMs - installState.dismissedAtMs >= INSTALL_DISMISS_COOLDOWN_MS
  if (!installState.available || installState.installed || !cooldownElapsed) return
  const prompt = deferredPrompt
  if (prompt === null) return

  // A BeforeInstallPromptEvent is one-use. Consume our reference before any
  // await so two idle callbacks cannot race the same event.
  deferredPrompt = null
  installState = reduceInstall(installState, { kind: 'promptShown' })
  try {
    await prompt.prompt()
    const choice = await prompt.userChoice
    if (choice.outcome !== 'dismissed') return
    installState = reduceInstall(installState, { kind: 'dismissed', nowMs })
    store.set(DISMISSED_AT_KEY, String(nowMs))
  } catch {
    // A platform/API failure is not a user dismissal and earns no cooldown.
  }
}

/* ------------------------------------------------------------- game lifecycle */

function startComposition(): { stop(): void } {
  const shell = startShell({
    canvas,
    root,
    clock: realFrameClock,
    store,
    renderer: createThreeRenderer(canvas, DEFAULT_THREE_OPTIONS),
    audio: nullAudioBackend,
    nfc,
    origin: appOrigin(),
  })

  const gate = installAudioGate((context) => {
    // GameShell applies the persisted settings immediately during this swap.
    shell.setAudio(createWebAudioBackend(context, { masterGain: 1, enabled: true }))
  })

  shell.onIdle(() => {
    void maybeOfferInstall(Date.now())
  })

  shell.onRaceStateChange((racing: boolean) => {
    updateState = reduceUpdate(updateState, {
      kind: racing ? 'raceStarted' : 'raceEnded',
    })
    if (!racing && waitingRegistration !== null) {
      offerUpdateIfAllowed(waitingRegistration)
    }
  })

  let stopped = false
  return {
    stop(): void {
      if (stopped) return
      stopped = true
      gate.dispose()
      shell.stop()
    },
  }
}

// `pagehide` fires on mobile Safari where `beforeunload` does not. A persisted
// `pageshow` is the one case where this module itself will not execute again,
// so rebuild the stopped shell without duplicating global PWA listeners.
installPageLifecycle(window, startComposition)
