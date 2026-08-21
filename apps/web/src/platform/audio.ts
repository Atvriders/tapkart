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
    window.removeEventListener('pointerdown', fire, true)
    window.removeEventListener('keydown', fire, true)
  }

  function arm(): void {
    if (disposed || published || resuming) return
    // CAPTURE, not bubble. The menu overlay covers the whole viewport on every
    // non-race screen and calls stopPropagation() on exactly these two events to
    // keep a tap on START from becoming the first steering pointer of the race.
    // In the bubble phase that also cancelled the audio unlock, so WebAudio did
    // not resume until the player was already racing -- the countdown was silent
    // on a cold start. Capture runs first, and stopPropagation cannot reach it.
    window.addEventListener('pointerdown', fire, { once: true, capture: true })
    window.addEventListener('keydown', fire, { once: true, capture: true })
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
