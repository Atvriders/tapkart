import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import type { ControlInputs } from '../src/controls/types'
import { DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import { makeKeyboardAdapter } from '../src/controls/keyboard'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

function poisonedIntent(): Intent {
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

function withKeys(...codes: string[]): ControlInputs {
  const keys: Record<string, boolean> = {}
  for (const c of codes) keys[c] = true
  return makeControlInputsFixture({ keys })
}

describe('keyboard adapter', () => {
  it('reports nothing pressed and writes every field of out', () => {
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    a.sample(withKeys(), 11, out)
    expect(out).toEqual({ tick: 11, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  })

  it('steers from the arrow keys and smooths at the same rate as touch', () => {
    // CATCHES an unsmoothed keyboard, which would make the merge rule
    // (greater |steer| wins) resolve to the keyboard on the first tick of every
    // touch input, because touch starts at 0.35 and a raw keyboard would be 1.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    const raw = withKeys('ArrowLeft')
    a.sample(raw, 0, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)
    a.sample(raw, 1, out)
    expect(out.steer).toBeCloseTo(-0.5775, 9)
    for (let t = 2; t < 30; t++) a.sample(raw, t, out)
    expect(out.steer).toBeLessThan(-0.999)
    expect(out.steer).toBeGreaterThanOrEqual(-1)
  })

  it('cancels to zero when both directions are held', () => {
    // CATCHES a "last key wins" implementation, which sticks at full lock when a
    // player rolls from one arrow to the other.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    const raw = withKeys('ArrowLeft', 'ArrowRight')
    for (let t = 0; t < 10; t++) a.sample(raw, t, out)
    expect(out.steer).toBe(0)
  })

  it('honours every alternate binding in the default table', () => {
    // CATCHES a hard-coded arrow-key reader that ignores cfg.keyBindings; WASD is
    // half the desktop players and would silently do nothing.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    a.sample(withKeys('KeyA'), 0, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)

    const b = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    b.sample(withKeys('KeyD'), 0, out)
    expect(out.steer).toBeCloseTo(0.35, 9)

    const c = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    c.sample(withKeys('KeyW'), 0, out)
    expect(out.accel).toBe(1)
    c.sample(withKeys('ArrowUp'), 1, out)
    expect(out.accel).toBe(1)

    const d = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    d.sample(withKeys('KeyS'), 0, out)
    expect(out.brake).toBe(true)
    d.sample(withKeys('ArrowDown'), 1, out)
    expect(out.brake).toBe(true)

    const e = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    e.sample(withKeys('Space'), 0, out)
    expect(out.drift).toBe(true)
    e.sample(withKeys('ShiftLeft'), 1, out)
    expect(out.drift).toBe(true)

    const f = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    f.sample(withKeys('ControlLeft'), 0, out)
    expect(out.useItem).toBe(true)
  })

  it('respects a custom binding table', () => {
    const a = makeKeyboardAdapter({
      ...DEFAULT_CONTROL_CONFIG,
      keyBindings: { KeyJ: 'left', KeyL: 'right', KeyI: 'accel' },
    })
    const out = poisonedIntent()
    a.sample(withKeys('KeyJ', 'KeyI'), 0, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)
    expect(out.accel).toBe(1)
    // ArrowLeft is unbound in this table, so the target is 0 and the smoothed
    // -0.35 decays to lerp(-0.35, 0, 0.35) = -0.2275. Under a hard-coded arrow
    // reader it would instead deepen to -0.5775.
    a.sample(withKeys('ArrowLeft'), 1, out)
    expect(out.steer).toBeCloseTo(-0.2275, 9)
    expect(out.accel).toBe(0)
  })

  it('ignores unbound keys and keys explicitly reported as up', () => {
    // CATCHES `if (raw.keys[code] !== undefined)`, which treats a keyup-recorded
    // `false` as a press - so every key ever touched stays down for the session.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    a.sample(makeControlInputsFixture({ keys: { KeyQ: true, ArrowLeft: false, KeyW: false } }), 0, out)
    expect(out.steer).toBe(0)
    expect(out.accel).toBe(0)
  })

  it('fires useItem on exactly one tick per press (Q25)', () => {
    // Held for four ticks, released, pressed again: a level implementation reports
    // true five times, this asserts exactly two.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    const held = withKeys('KeyE')
    const idle = withKeys()
    const fired: number[] = []
    for (let t = 0; t <= 3; t++) {
      a.sample(held, t, out)
      if (out.useItem) fired.push(t)
    }
    a.sample(idle, 4, out)
    if (out.useItem) fired.push(4)
    a.sample(held, 5, out)
    if (out.useItem) fired.push(5)
    expect(fired).toEqual([0, 5])
  })

  it('reports its scheme and drops the smoothing and item latch on reset', () => {
    // The keyboard adapter is always the composite's secondary, so its scheme is
    // never the one the player selected; thumbZones is the harmless default.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    expect(a.scheme).toBe('thumbZones')
    const out = poisonedIntent()
    const held = withKeys('ArrowLeft', 'KeyE')
    for (let t = 0; t < 20; t++) a.sample(held, t, out)
    expect(out.steer).toBeLessThan(-0.99)
    expect(out.useItem).toBe(false)

    a.reset()
    a.sample(held, 20, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)
    expect(out.useItem).toBe(true)
  })
})
