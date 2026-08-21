import { describe, expect, it, vi } from 'vitest'

import { createDisplayHost } from '../src/platform/fullscreen'

function fakeDoc(over: Partial<{ enabled: boolean; element: unknown; request: unknown }> = {}) {
  const request = 'request' in over ? over.request : vi.fn(async () => {})
  return {
    fullscreenEnabled: over.enabled ?? true,
    fullscreenElement: (over.element ?? null) as Element | null,
    documentElement: { requestFullscreen: request as (() => Promise<void>) | undefined },
    _request: request,
  }
}

describe('the browser display host degrades instead of throwing', () => {
  it('reports no support when the API is absent, as on iPhone', () => {
    // iPhone Safari has no Element.requestFullscreen at all.
    const host = createDisplayHost(fakeDoc({ request: undefined }), new EventTarget())
    expect(host.supported()).toBe(false)
    expect(host.isFullscreen()).toBe(false)
  })

  it('reports no support when the document forbids fullscreen', () => {
    // A cross-origin iframe without allow="fullscreen".
    expect(createDisplayHost(fakeDoc({ enabled: false }), new EventTarget()).supported()).toBe(false)
  })

  it('swallows a rejected request rather than throwing inside the click handler', async () => {
    // This is the whole point. A throw here happens INSIDE the character button's
    // click handler, so the guest cannot pick a character and cannot play.
    const doc = fakeDoc({ request: vi.fn(async () => { throw new Error('denied') }) })
    const host = createDisplayHost(doc, new EventTarget())
    await expect(host.request()).resolves.toBeUndefined()
    expect(doc._request).toHaveBeenCalledTimes(1)
  })

  it('requests fullscreen on the document element', async () => {
    const doc = fakeDoc()
    await createDisplayHost(doc, new EventTarget()).request()
    expect(doc._request).toHaveBeenCalledTimes(1)
  })

  it('reflects the current fullscreen element', () => {
    expect(createDisplayHost(fakeDoc(), new EventTarget()).isFullscreen()).toBe(false)
    expect(createDisplayHost(fakeDoc({ element: {} }), new EventTarget()).isFullscreen()).toBe(true)
  })

  it('stops notifying once disposed, so a bfcache restore cannot double-register', () => {
    const events = new EventTarget()
    const cb = vi.fn()
    const off = createDisplayHost(fakeDoc(), events).onChange(cb)
    events.dispatchEvent(new Event('fullscreenchange'))
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    events.dispatchEvent(new Event('fullscreenchange'))
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
