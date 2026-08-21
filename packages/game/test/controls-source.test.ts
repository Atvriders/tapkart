import { describe, expect, it } from 'vitest'

import { createControlInputs } from '../src/controls/types'
import { attachInputSource } from '../src/controls/source'
import type { TiltSample } from '../src/controls/types'

function orientation(alpha: number | null, beta: number | null, gamma: number | null): Event {
  const event = new Event('deviceorientation')
  Object.defineProperties(event, {
    alpha: { value: alpha },
    beta: { value: beta },
    gamma: { value: gamma },
  })
  return event
}

describe('InputSource tilt snapshot seam', () => {
  it('atomically copies the newest complete finite orientation sample', () => {
    const target = new EventTarget()
    const source = attachInputSource(target, { width: 800, height: 400 }, { top: 0, right: 0, bottom: 0, left: 0 })
    const out: TiltSample = { alpha: 91, beta: 92, gamma: 93 }

    expect(source.snapshotTilt(out)).toBe(false)
    expect(out).toEqual({ alpha: 91, beta: 92, gamma: 93 })

    target.dispatchEvent(orientation(12, 3, -7))
    expect(source.snapshotTilt(out)).toBe(true)
    expect(out).toEqual({ alpha: 12, beta: 3, gamma: -7 })

    target.dispatchEvent(orientation(1, Number.NaN, 2))
    target.dispatchEvent(orientation(null, 50, 60))
    expect(source.snapshotTilt(out)).toBe(true)
    expect(out).toEqual({ alpha: 12, beta: 3, gamma: -7 })

    source.detach()
    target.dispatchEvent(orientation(30, 40, 50))
    expect(source.snapshotTilt(out)).toBe(true)
    expect(out).toEqual({ alpha: 12, beta: 3, gamma: -7 })
  })
})

describe('InputSource carries the safe-area insets alongside the viewport', () => {
  it('copies the caller\'s live insets on every drain, not a snapshot from attach time', () => {
    const target = new EventTarget()
    const viewport = { width: 844, height: 390 }
    // Caller-owned, exactly like `viewport`: the shell re-measures into this same
    // object when a system bar appears, and drain must see the new value. A copy
    // taken at attach time would leave the layout using yesterday's cutout.
    const insets = { top: 0, right: 0, bottom: 0, left: 0 }
    const source = attachInputSource(target, viewport, insets)
    const out = createControlInputs()

    source.drain(out)
    expect(out.insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })

    insets.top = 44
    insets.right = 48
    insets.bottom = 24
    insets.left = 12
    source.drain(out)
    expect(out.insets).toEqual({ top: 44, right: 48, bottom: 24, left: 12 })

    // Copied, not aliased: mutating the output must not write back to the shell's.
    out.insets.top = 999
    expect(insets.top).toBe(44)
    source.detach()
  })
})
