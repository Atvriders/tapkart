import { afterEach, describe, expect, it, vi } from 'vitest'
import { nullNfcHost } from '@tapkart/invite'
import { appOrigin, BUILD_ORIGIN, IS_NATIVE } from '../src/platform/env'
import { capacitorNfcHost } from '../src/platform/nfc'
import { installAudioGate } from '../src/platform/audio'

describe('platform/env — the single permitted platform check (§10.1)', () => {
  it('is not native under a headless run, because there is no Capacitor bridge', () => {
    expect(IS_NATIVE).toBe(false)
  })

  it('has an empty build origin when VITE_TAPKART_ORIGIN is unset', () => {
    expect(BUILD_ORIGIN).toBe('')
  })

  it('never carries a trailing slash, whatever the variable said', () => {
    expect(BUILD_ORIGIN.endsWith('/')).toBe(false)
  })

  it('returns a string and does not throw where there is no location', () => {
    expect(typeof appOrigin()).toBe('string')
  })
})

describe('platform/nfc — the browser build registers no plugin (§10.2)', () => {
  it('returns nullNfcHost when not native', () => {
    expect(capacitorNfcHost()).toBe(nullNfcHost)
  })

  it('reports no NFC support at all, and resolves rather than rejecting', async () => {
    await expect(capacitorNfcHost().supported()).resolves.toEqual({
      hardware: false,
      hce: false,
      adapterEnabled: false,
    })
  })

  it('resolves a null pending invite instead of hanging', async () => {
    await expect(capacitorNfcHost().pendingInvite()).resolves.toBeNull()
  })

  it('advertising and reader calls resolve, so browser screens never wait forever', async () => {
    const host = capacitorNfcHost()
    await expect(host.advertise('https://tapkart.example/r/ABCDE')).resolves.toBeUndefined()
    await expect(host.stop()).resolves.toBeUndefined()
    await expect(host.startReader()).resolves.toBeUndefined()
    await expect(host.stopReader()).resolves.toBeUndefined()
  })

  it('onInvite returns an unsubscribe that can be called safely', () => {
    const off = capacitorNfcHost().onInvite(() => undefined)
    expect(typeof off).toBe('function')
    expect(() => off()).not.toThrow()
  })
})

describe('platform/audio — one user-gesture gate (§9.4)', () => {
  const originalWindow = globalThis.window
  const originalAudioContext = globalThis.AudioContext

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    if (originalAudioContext === undefined) Reflect.deleteProperty(globalThis, 'AudioContext')
    else Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: originalAudioContext,
    })
  })

  it('constructs, resumes and publishes exactly one context on the first gesture', async () => {
    const fakeWindow = new EventTarget()
    const resume = vi.fn(() => Promise.resolve())
    const contexts: object[] = []
    class FakeAudioContext {
      constructor() {
        contexts.push(this)
      }
      resume = resume
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    })
    const onReady = vi.fn()

    const gate = installAudioGate(onReady)
    fakeWindow.dispatchEvent(new Event('pointerdown'))
    fakeWindow.dispatchEvent(new Event('keydown'))
    await Promise.resolve()

    expect(contexts).toHaveLength(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(gate.context).toBe(contexts[0])
  })

  it('can be disposed before a gesture without constructing a context', () => {
    const fakeWindow = new EventTarget()
    const constructor = vi.fn()
    class FakeAudioContext {
      constructor() {
        constructor()
      }
      resume(): Promise<void> {
        return Promise.resolve()
      }
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    })

    const gate = installAudioGate(() => undefined)
    gate.dispose()
    fakeWindow.dispatchEvent(new Event('pointerdown'))

    expect(constructor).not.toHaveBeenCalled()
    expect(gate.context).toBeNull()
  })

  it('consumes a failed resume and retries the same context on the next gesture', async () => {
    const fakeWindow = new EventTarget()
    const resume = vi.fn()
      .mockRejectedValueOnce(new Error('temporarily denied'))
      .mockResolvedValueOnce(undefined)
    const contexts: object[] = []
    class FakeAudioContext {
      constructor() {
        contexts.push(this)
      }
      resume = resume
      close(): Promise<void> {
        return Promise.resolve()
      }
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    })
    const onReady = vi.fn()

    const gate = installAudioGate(onReady)
    fakeWindow.dispatchEvent(new Event('pointerdown'))
    await Promise.resolve()
    await Promise.resolve()
    expect(onReady).not.toHaveBeenCalled()

    fakeWindow.dispatchEvent(new Event('keydown'))
    await Promise.resolve()
    await Promise.resolve()

    expect(contexts).toHaveLength(1)
    expect(resume).toHaveBeenCalledTimes(2)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(gate.context).toBe(contexts[0])
  })
})
