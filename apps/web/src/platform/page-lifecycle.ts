// ADAPTER. Owns only the browser document lifecycle; composing the game stays
// in main.ts, while this tiny seam makes bfcache recovery deterministic.

interface PageComposition {
  stop(): void
}

/** Starts one composition immediately, tears it down on pagehide, and rebuilds
 * it once when a persisted page is restored from the back-forward cache. */
export function installPageLifecycle(
  target: EventTarget,
  start: () => PageComposition,
): () => void {
  let active: PageComposition | null = start()
  let disposed = false

  const stopActive = (): void => {
    const current = active
    if (current === null) return
    // Clear first so a re-entrant lifecycle event cannot stop it twice.
    active = null
    current.stop()
  }

  const onPageHide = (): void => {
    stopActive()
  }
  const onPageShow = (event: Event): void => {
    if (disposed || active !== null || !(event as PageTransitionEvent).persisted) return
    active = start()
  }

  target.addEventListener('pagehide', onPageHide)
  target.addEventListener('pageshow', onPageShow)

  return (): void => {
    if (disposed) return
    disposed = true
    target.removeEventListener('pagehide', onPageHide)
    target.removeEventListener('pageshow', onPageShow)
    stopActive()
  }
}
