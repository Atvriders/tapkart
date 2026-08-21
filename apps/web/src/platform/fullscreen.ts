import type { DisplayHost } from '@tapkart/game'
import { nullDisplayHost } from '@tapkart/game'

/** The narrow slice of `document` this needs, injected so it can be faked. */
export interface FullscreenDoc {
  fullscreenEnabled?: boolean
  fullscreenElement?: Element | null
  documentElement: { requestFullscreen?: () => Promise<void> }
}

/**
 * The browser half of DisplayHost.
 *
 * Feature detection here is load-bearing rather than defensive. On iPhone
 * `Element.requestFullscreen` does not exist at all, and the legacy
 * `webkitRequestFullscreen` returns undefined rather than a Promise -- so
 * `el.requestFullscreen().catch(...)` throws a TypeError synchronously, inside
 * the click handler that called it. On the character-select screen that is the
 * NFC guest's very first tap, and the failure would not be "no fullscreen", it
 * would be "cannot choose a character and therefore cannot play".
 */
export function createDisplayHost(doc: FullscreenDoc, events: EventTarget): DisplayHost {
  const request = doc.documentElement.requestFullscreen
  if (doc.fullscreenEnabled !== true || typeof request !== 'function') return nullDisplayHost

  return {
    supported: () => true,
    isFullscreen: () => doc.fullscreenElement != null,
    async request(): Promise<void> {
      try {
        await doc.documentElement.requestFullscreen?.()
      } catch {
        // A refusal is not an error worth surfacing: the page is simply not
        // fullscreen, which is the state it was already in.
      }
    },
    onChange(cb: () => void): () => void {
      events.addEventListener('fullscreenchange', cb)
      return () => events.removeEventListener('fullscreenchange', cb)
    },
  }
}
