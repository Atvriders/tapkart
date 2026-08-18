// PURE. Contract §8.5.

export interface InstallState {
  available: boolean
  installed: boolean
  dismissedAtMs: number
}

export type InstallEvent =
  | { kind: 'promptAvailable' }
  | { kind: 'promptShown' }
  | { kind: 'dismissed'; nowMs: number }
  | { kind: 'installed' }

export const INSTALL_DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000

export function createInstallState(): InstallState {
  return { available: false, installed: false, dismissedAtMs: 0 }
}

/** Pure, with by-reference returns for no-op transitions. */
export function reduceInstall(prev: InstallState, ev: InstallEvent): InstallState {
  if (prev.installed) return prev

  switch (ev.kind) {
    case 'promptAvailable':
      return prev.available ? prev : { ...prev, available: true }
    case 'promptShown':
      return prev.available ? { ...prev, available: false } : prev
    case 'dismissed':
      return { ...prev, available: false, dismissedAtMs: ev.nowMs }
    case 'installed':
      return { available: false, installed: true, dismissedAtMs: prev.dismissedAtMs }
  }
}
