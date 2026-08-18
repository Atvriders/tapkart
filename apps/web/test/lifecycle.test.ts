import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { installPageLifecycle } from '../src/platform/page-lifecycle'

const MAIN_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/main.ts', import.meta.url)),
  'utf8',
)

function between(start: string, end: string): string {
  const from = MAIN_SOURCE.indexOf(start)
  const to = MAIN_SOURCE.indexOf(end, from + start.length)
  expect(from, `missing source marker: ${start}`).toBeGreaterThan(-1)
  expect(to, `missing source marker: ${end}`).toBeGreaterThan(from)
  return MAIN_SOURCE.slice(from, to)
}

describe('the PWA lifecycle composition (§8.5, §15.2)', () => {
  it('retains the waiting registration and re-offers it after a race ends', () => {
    expect(MAIN_SOURCE).toContain(
      'let waitingRegistration: ServiceWorkerRegistration | null = null',
    )
    const waiting = between('const noteWaiting', "registration.addEventListener('updatefound'")
    expect(waiting).toContain('waitingRegistration = registration')
    expect(waiting.indexOf('waitingRegistration = registration')).toBeLessThan(
      waiting.indexOf('offerUpdateIfAllowed(waitingRegistration)'),
    )

    const raceLifecycle = between('shell.onRaceStateChange', 'let stopped = false')
    expect(raceLifecycle).toContain("kind: racing ? 'raceStarted' : 'raceEnded'")
    expect(raceLifecycle).toContain('if (!racing && waitingRegistration !== null)')
    expect(raceLifecycle).toContain('offerUpdateIfAllowed(waitingRegistration)')
  })

  it('keeps a rejected service-worker registration out of the page error channel', () => {
    const registration = between(
      "navigator.serviceWorker.register('/sw.js')",
      'let reloading = false',
    )
    expect(registration).toContain('.catch(() =>')
  })

  it('persists only the browser-reported install dismissal outcome', () => {
    const promptInterface = between('interface BeforeInstallPromptEvent', 'let deferredPrompt')
    expect(promptInterface).toContain('userChoice: Promise<')
    expect(promptInterface).toContain("outcome: 'accepted' | 'dismissed'")

    const offer = between('function maybeOfferInstall', 'shell.onIdle')
    expect(offer).toContain('await prompt.prompt()')
    expect(offer).toContain('await prompt.userChoice')
    expect(offer).toContain("choice.outcome !== 'dismissed'")
    expect(offer).toContain("kind: 'dismissed', nowMs")
    expect(offer).toContain("store.set(DISMISSED_AT_KEY, String(nowMs))")
    expect(offer).not.toMatch(/prompt\(\)\.catch[\s\S]*kind: 'dismissed'/)
  })

  it('owns shell and audio teardown inside the restartable composition', () => {
    const composition = between('function startComposition', 'installPageLifecycle')
    expect(composition).toContain('gate.dispose()')
    expect(composition).toContain('shell.stop()')
  })
})

function transition(type: 'pagehide' | 'pageshow', persisted: boolean): Event {
  const event = new Event(type)
  Object.defineProperty(event, 'persisted', { value: persisted })
  return event
}

describe('back-forward cache recovery', () => {
  it('rebuilds a stopped title exactly once on a persisted pageshow', () => {
    const page = new EventTarget()
    const root = { textContent: '' }
    let starts = 0
    let stops = 0

    const dispose = installPageLifecycle(page, () => {
      starts += 1
      root.textContent = 'TAPKART'
      let stopped = false
      return {
        stop(): void {
          if (stopped) return
          stopped = true
          stops += 1
          root.textContent = ''
        },
      }
    })

    expect(root.textContent).toBe('TAPKART')
    expect(starts).toBe(1)

    page.dispatchEvent(transition('pagehide', true))
    expect(root.textContent).toBe('')
    expect(stops).toBe(1)

    page.dispatchEvent(transition('pageshow', true))
    expect(root.textContent).toBe('TAPKART')
    expect(starts).toBe(2)

    // Browsers and test harnesses may replay pageshow. A live composition is
    // never duplicated, and the initial non-persisted pageshow is also inert.
    page.dispatchEvent(transition('pageshow', true))
    page.dispatchEvent(transition('pageshow', false))
    expect(starts).toBe(2)

    dispose()
    dispose()
    expect(stops).toBe(2)
  })

  it('does not resurrect a lifecycle after its owner disposes it', () => {
    const page = new EventTarget()
    let starts = 0
    const dispose = installPageLifecycle(page, () => {
      starts += 1
      return { stop(): void {} }
    })

    dispose()
    page.dispatchEvent(transition('pagehide', true))
    page.dispatchEvent(transition('pageshow', true))
    expect(starts).toBe(1)
  })
})
