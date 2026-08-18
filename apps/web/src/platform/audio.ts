// ADAPTER. Contract §9.4. This is the only place that constructs an
// AudioContext; construction and resume both happen in the first user gesture.

export interface AudioGate {
  context: AudioContext | null
  dispose(): void
}

export function installAudioGate(onReady: (ctx: AudioContext) => void): AudioGate {
  let disposed = false
  let resuming = false
  let published = false

  function disarm(): void {
    window.removeEventListener('pointerdown', fire)
    window.removeEventListener('keydown', fire)
  }

  function arm(): void {
    if (disposed || published || resuming) return
    window.addEventListener('pointerdown', fire, { once: true })
    window.addEventListener('keydown', fire, { once: true })
  }

  const gate: AudioGate = {
    context: null,
    dispose(): void {
      if (disposed) return
      disposed = true
      disarm()
      // Before publication no backend owns this context yet. Do not leave a
      // failed/suspended context alive when the page is being torn down.
      if (!published && gate.context !== null) {
        void gate.context.close().catch(() => undefined)
      }
    },
  }

  function fire(): void {
    if (disposed || published || resuming) return
    disarm()
    if (typeof AudioContext === 'undefined') return

    let context = gate.context
    try {
      if (context === null) {
        context = new AudioContext()
        gate.context = context
      }
    } catch {
      // A transient platform refusal should not consume the only gesture the
      // game will ever listen for.
      arm()
      return
    }

    resuming = true
    void context.resume().then(
      () => {
        resuming = false
        if (disposed) return
        published = true
        onReady(context)
      },
      () => {
        // Reuse the same suspended context on the next real gesture. This also
        // consumes the rejection, keeping a recoverable audio failure out of
        // the page's unhandled-error channel.
        resuming = false
        arm()
      },
    )
  }

  arm()
  return gate
}
