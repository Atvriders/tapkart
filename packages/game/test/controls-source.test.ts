import { describe, expect, it } from 'vitest'

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
    const source = attachInputSource(target, { width: 800, height: 400 })
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
