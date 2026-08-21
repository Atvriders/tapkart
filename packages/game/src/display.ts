/**
 * Whether the page is filling the screen, and when it is legal to ask.
 *
 * Pure. The browser half lives in apps/web/src/platform/fullscreen.ts; this
 * module holds the decision, because the decision is the part with rules worth
 * testing and the API call is the part that cannot be tested without a browser.
 *
 * Not used inside the APK. Capacitor's BridgeWebChromeClient answers
 * onShowCustomView by immediately calling onCustomViewHidden, so an HTML
 * fullscreen request is cancelled on the same tick; the native immersive mode
 * is the APK's answer instead.
 */

/** The browser capability, injected so the shell never touches a global. */
export interface DisplayHost {
  supported(): boolean
  isFullscreen(): boolean
  request(): Promise<void>
  onChange(cb: () => void): () => void
}

/** Mirrors nullNfcHost: absence is a working configuration, not an error. */
export const nullDisplayHost: DisplayHost = {
  supported: () => false,
  isFullscreen: () => false,
  request: async () => {},
  onChange: () => () => {},
}

export interface FullscreenGate {
  /** Still worth asking on the next gesture. */
  armed: boolean
  /** The player left fullscreen deliberately; do not ask again unprompted. */
  userExited: boolean
}

export function createFullscreenGate(): FullscreenGate {
  return { armed: true, userExited: false }
}

export type FullscreenEvent =
  | { kind: 'gesture' }
  | { kind: 'entered' }
  | { kind: 'left' }
  | { kind: 'explicitRequest' }

/**
 * Returns the next gate and whether the caller should call `host.request()`.
 *
 * The rule that matters is `userExited`: once someone has deliberately left
 * fullscreen, asking again on their next tap is a fight they cannot win, and
 * browsers throttle repeated requests anyway. The settings toggle is the way
 * back in, and it clears the flag because it is an explicit choice rather than
 * an inferred one.
 */
export function reduceFullscreen(
  gate: FullscreenGate,
  ev: FullscreenEvent,
): { gate: FullscreenGate; ask: boolean } {
  switch (ev.kind) {
    case 'gesture':
      if (!gate.armed || gate.userExited) return { gate, ask: false }
      return { gate: { armed: false, userExited: false }, ask: true }
    case 'entered':
      return { gate: { armed: false, userExited: false }, ask: false }
    case 'left':
      return { gate: { armed: false, userExited: true }, ask: false }
    case 'explicitRequest':
      return { gate: { armed: false, userExited: false }, ask: true }
  }
}
