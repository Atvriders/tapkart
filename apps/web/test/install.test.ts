import { describe, expect, it } from 'vitest'
import {
  createInstallState,
  INSTALL_DISMISS_COOLDOWN_MS,
  reduceInstall,
  type InstallEvent,
  type InstallState,
} from '../src/pwa/install'

const ALL_EVENTS: InstallEvent[] = [
  { kind: 'promptAvailable' },
  { kind: 'promptShown' },
  { kind: 'dismissed', nowMs: 1_000 },
  { kind: 'installed' },
]

describe('INSTALL_DISMISS_COOLDOWN_MS', () => {
  it('is seven days, in milliseconds', () => {
    expect(INSTALL_DISMISS_COOLDOWN_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(INSTALL_DISMISS_COOLDOWN_MS).toBe(604_800_000)
  })
})

describe('createInstallState', () => {
  it('starts unavailable, uninstalled, and never dismissed', () => {
    expect(createInstallState()).toEqual({ available: false, installed: false, dismissedAtMs: 0 })
  })
})

describe('reduceInstall', () => {
  it('never mutates prev', () => {
    for (const ev of ALL_EVENTS) {
      const prev: InstallState = { available: true, installed: false, dismissedAtMs: 5 }
      const snapshot = { ...prev }
      reduceInstall(prev, ev)
      expect(prev).toEqual(snapshot)
    }
  })

  it('promptAvailable makes the prompt available', () => {
    expect(reduceInstall(createInstallState(), { kind: 'promptAvailable' })).toEqual({
      available: true,
      installed: false,
      dismissedAtMs: 0,
    })
  })

  it('promptShown consumes availability', () => {
    const available: InstallState = { available: true, installed: false, dismissedAtMs: 0 }
    expect(reduceInstall(available, { kind: 'promptShown' })).toEqual({
      available: false,
      installed: false,
      dismissedAtMs: 0,
    })
  })

  it('dismissed records when and stops offering', () => {
    const available: InstallState = { available: true, installed: false, dismissedAtMs: 0 }
    expect(reduceInstall(available, { kind: 'dismissed', nowMs: 1_700_000_000_000 })).toEqual({
      available: false,
      installed: false,
      dismissedAtMs: 1_700_000_000_000,
    })
  })

  it('installed is terminal: nothing makes it available again', () => {
    let state = reduceInstall(createInstallState(), { kind: 'installed' })
    expect(state).toEqual({ available: false, installed: true, dismissedAtMs: 0 })
    for (const ev of ALL_EVENTS) {
      state = reduceInstall(state, ev)
      expect(state.installed).toBe(true)
      expect(state.available).toBe(false)
    }
  })

  it('promptAvailable on an installed app is a no-op by reference', () => {
    const installed: InstallState = { available: false, installed: true, dismissedAtMs: 0 }
    expect(reduceInstall(installed, { kind: 'promptAvailable' })).toBe(installed)
  })

  it('a later dismissal overwrites an earlier one', () => {
    let state: InstallState = { available: true, installed: false, dismissedAtMs: 100 }
    state = reduceInstall(state, { kind: 'dismissed', nowMs: 200 })
    expect(state.dismissedAtMs).toBe(200)
  })

  it('supports the caller cooldown predicate', () => {
    const dismissedAt = 1_000_000
    const state: InstallState = { available: true, installed: false, dismissedAtMs: dismissedAt }
    const canPrompt = (candidate: InstallState, nowMs: number) =>
      candidate.available &&
      !candidate.installed &&
      nowMs - candidate.dismissedAtMs >= INSTALL_DISMISS_COOLDOWN_MS
    expect(canPrompt(state, dismissedAt + INSTALL_DISMISS_COOLDOWN_MS - 1)).toBe(false)
    expect(canPrompt(state, dismissedAt + INSTALL_DISMISS_COOLDOWN_MS)).toBe(true)
  })
})
