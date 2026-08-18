// PURE — interfaces only, plus one inert implementation. `packages/invite`
// declares this seam and never holds a real implementation of it.

export interface NfcSupport {
  /** Device has NFC hardware. */
  hardware: boolean
  /** Device supports Host Card Emulation. */
  hce: boolean
  /** NFC is switched on right now. */
  adapterEnabled: boolean
}

/** Where an invite URI reached this device. F-P5-16 puts two entry points on one
 *  path; this is the only thing that distinguishes them, and it exists for the
 *  log line, not for a branch. */
export type InviteSource = 'tag' | 'appLink'

/** The seam. `apps/web` supplies a Capacitor-backed implementation on Android
 *  and `nullNfcHost` everywhere else. `packages/game` holds one and must never
 *  construct one. */
export interface NfcHost {
  supported(): Promise<NfcSupport>
  /** Idempotent. Starts emulating a tag serving `uri` and keeps the screen on. */
  advertise(uri: string): Promise<void>
  /** Idempotent. Serves the empty NDEF file and releases the screen lock. */
  stop(): Promise<void>
  /** Idempotent. Enables foreground ISO-DEP invite reads on a guest screen. */
  startReader(): Promise<void>
  /** Idempotent. Disables foreground invite reads. */
  stopReader(): Promise<void>
  /** Both entry points, one callback (F-P5-16). Returns an unsubscribe function. */
  onInvite(cb: (uri: string, source: InviteSource) => void): () => void
  /** The URI the launch intent carried, consumed once and then null.
   *
   *  Required, not convenience: a cold-start App Link is delivered before any JS
   *  has run, so `onInvite` cannot have been registered yet and the invite is
   *  silently lost without this. That is a tap that does nothing — the exact
   *  failure mode this plan is written to prevent. */
  pendingInvite(): Promise<string | null>
}

const NO_OP_UNSUBSCRIBE = (): void => {}

/** Every method resolves; `supported()` reports all false; `onInvite` returns a
 *  no-op unsubscribe; `pendingInvite()` resolves null. Browsers and desktop get
 *  this, and so does `startShell` when `opts.nfc` is absent. */
export const nullNfcHost: NfcHost = {
  supported(): Promise<NfcSupport> {
    return Promise.resolve({ hardware: false, hce: false, adapterEnabled: false })
  },
  advertise(): Promise<void> {
    return Promise.resolve()
  },
  stop(): Promise<void> {
    return Promise.resolve()
  },
  startReader(): Promise<void> {
    return Promise.resolve()
  },
  stopReader(): Promise<void> {
    return Promise.resolve()
  },
  onInvite(): () => void {
    return NO_OP_UNSUBSCRIBE
  },
  pendingInvite(): Promise<string | null> {
    return Promise.resolve(null)
  },
}
