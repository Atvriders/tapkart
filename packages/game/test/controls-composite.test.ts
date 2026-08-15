import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs, ControlScheme } from '../src/controls/types'
import { DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import { makeCompositeAdapter, mergeIntents } from '../src/controls/composite'
import { makeControlAdapter } from '../src/controls/index'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

function intent(o: Partial<Intent>): Intent {
  return { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false, ...o }
}

function poisonedIntent(): Intent {
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

/** Records what it was handed, so the composite's scratch discipline is testable.
 *  `log` is a separate object rather than a self-reference, because an object
 *  literal whose method reads the const it is initialising infers `any` (TS7022). */
function spyAdapter(scheme: ControlScheme, write: Partial<Intent>): ControlAdapter & {
  log: { outs: Intent[]; resets: number }
} {
  const log = { outs: [] as Intent[], resets: 0 }
  return {
    scheme,
    log,
    sample(_raw: ControlInputs, tick: number, out: Intent): void {
      if (!log.outs.includes(out)) log.outs.push(out)
      out.tick = tick
      out.steer = write.steer ?? 0
      out.accel = write.accel ?? 0
      out.brake = write.brake ?? false
      out.drift = write.drift ?? false
      out.useItem = write.useItem ?? false
    },
    reset(): void {
      log.resets++
    },
  }
}

describe('mergeIntents (Q23)', () => {
  it('gives steer to the greater absolute magnitude, as a table', () => {
    // Every row uses DIFFERENT magnitudes on the two sides, except the two tie rows
    // where the sign differs. A row where both sides agree would prove nothing
    // about the rule - it is satisfied by "return touch" and by "return keyboard".
    const rows: { touch: number; kb: number; want: number }[] = [
      { touch: 0.9, kb: -0.5, want: 0.9 },
      { touch: -0.2, kb: 0.6, want: 0.6 },
      { touch: 0.1, kb: 0, want: 0.1 },
      { touch: 0, kb: -0.4, want: -0.4 },
      { touch: 0.5, kb: -0.5, want: -0.5 }, // tie -> keyboard
      { touch: -0.7, kb: 0.7, want: 0.7 }, // tie -> keyboard
      { touch: 0, kb: 0, want: 0 },
      { touch: -1, kb: 0.99, want: -1 },
    ]
    const out = poisonedIntent()
    for (const r of rows) {
      mergeIntents(intent({ steer: r.touch }), intent({ steer: r.kb }), out)
      expect(out.steer).toBe(r.want)
    }
  })

  it('takes the maximum accel', () => {
    // CATCHES a sum (which exceeds 1) and "keyboard wins" (which zeroes the throttle
    // of every auto-accelerate scheme the moment a desktop player touches a key).
    const out = poisonedIntent()
    const rows: [number, number, number][] = [
      [1, 0, 1],
      [0, 1, 1],
      [0.3, 0.7, 0.7],
      [0.7, 0.3, 0.7],
      [0, 0, 0],
    ]
    for (const [touch, kb, want] of rows) {
      mergeIntents(intent({ accel: touch }), intent({ accel: kb }), out)
      expect(out.accel).toBe(want)
    }
  })

  it('ORs brake, drift and useItem across all four combinations each', () => {
    // CATCHES an AND, and a merge that reads only one side. All four rows per field.
    const out = poisonedIntent()
    for (const [t, k] of [[false, false], [true, false], [false, true], [true, true]] as [boolean, boolean][]) {
      mergeIntents(intent({ brake: t }), intent({ brake: k }), out)
      expect(out.brake).toBe(t || k)
      mergeIntents(intent({ drift: t }), intent({ drift: k }), out)
      expect(out.drift).toBe(t || k)
      mergeIntents(intent({ useItem: t }), intent({ useItem: k }), out)
      expect(out.useItem).toBe(t || k)
    }
  })

  it('writes every field of out, leaving nothing from a previous merge', () => {
    const out = poisonedIntent()
    mergeIntents(intent({ tick: 5 }), intent({ tick: 5 }), out)
    expect(out).toEqual({ tick: 5, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  })

  it('takes tick from the keyboard side, the same side that wins steer ties', () => {
    const out = poisonedIntent()
    mergeIntents(intent({ tick: 5 }), intent({ tick: 7 }), out)
    expect(out.tick).toBe(7)
  })
})

describe('makeCompositeAdapter (Q23)', () => {
  it('reports the primary scheme and merges both sub-adapters', () => {
    const touch = spyAdapter('virtualStick', { steer: 0.2, accel: 1, drift: true })
    const kb = spyAdapter('thumbZones', { steer: -0.8, brake: true, useItem: true })
    const c = makeCompositeAdapter(touch, kb)
    const out = poisonedIntent()
    c.sample(makeControlInputsFixture(), 9, out)
    expect(c.scheme).toBe('virtualStick')
    expect(out).toEqual({ tick: 9, steer: -0.8, accel: 1, brake: true, drift: true, useItem: true })
  })

  it('never hands `out` to a sub-adapter: each gets its own scratch Intent', () => {
    // THE SOLE-WRITER TEST (§7.2). If the composite passes `out` down, the last
    // sub-adapter to run silently becomes the writer of the Intent the session
    // submits, and the merge rule stops existing - while every value-based test
    // above still passes, because the last writer happens to be the keyboard.
    const touch = spyAdapter('tilt', { steer: 0.5 })
    const kb = spyAdapter('thumbZones', { steer: -0.25 })
    const c = makeCompositeAdapter(touch, kb)
    const out = poisonedIntent()
    c.sample(makeControlInputsFixture(), 1, out)
    c.sample(makeControlInputsFixture(), 2, out)
    expect(touch.log.outs).toHaveLength(1)
    expect(kb.log.outs).toHaveLength(1)
    expect(touch.log.outs[0]).not.toBe(out)
    expect(kb.log.outs[0]).not.toBe(out)
    expect(touch.log.outs[0]).not.toBe(kb.log.outs[0])
    expect(out.steer).toBe(0.5)
  })

  it('resets both sub-adapters', () => {
    const touch = spyAdapter('tilt', {})
    const kb = spyAdapter('thumbZones', {})
    const c = makeCompositeAdapter(touch, kb)
    c.reset()
    expect(touch.log.resets).toBe(1)
    expect(kb.log.resets).toBe(1)
  })
})

describe('makeControlAdapter', () => {
  it('reports the requested scheme for all three', () => {
    for (const s of ['thumbZones', 'tilt', 'virtualStick'] as ControlScheme[]) {
      expect(makeControlAdapter(s, DEFAULT_CONTROL_CONFIG).scheme).toBe(s)
    }
  })

  it('merges the keyboard into every scheme, on every platform', () => {
    // CATCHES makeControlAdapter returning the bare touch adapter. Each assertion
    // is chosen so the touch adapter alone CANNOT produce it: thumbZones and tilt
    // have no drift key and no steering keys, and virtualStick's accel is 0 unless
    // its gas button is down.
    const tz = makeControlAdapter('thumbZones', DEFAULT_CONTROL_CONFIG)
    const outTz = poisonedIntent()
    tz.sample(makeControlInputsFixture({ keys: { ShiftLeft: true } }), 0, outTz)
    expect(outTz.drift).toBe(true)

    const tilt = makeControlAdapter('tilt', DEFAULT_CONTROL_CONFIG)
    const outTilt = poisonedIntent()
    tilt.sample(makeControlInputsFixture({ keys: { ArrowLeft: true } }), 0, outTilt)
    expect(outTilt.steer).toBeCloseTo(-0.35, 9)

    const stick = makeControlAdapter('virtualStick', DEFAULT_CONTROL_CONFIG)
    const outStick = poisonedIntent()
    stick.sample(makeControlInputsFixture({ keys: { KeyW: true } }), 0, outStick)
    expect(outStick.accel).toBe(1)
  })

  it('lets the larger input win, in both directions, over a real touch session', () => {
    // The integration case the unit table cannot cover: both sides are live and
    // smoothing moves them past each other. Touch settles at half lock (0.5); the
    // keyboard then ramps 0.35 -> 0.5775 and takes over on the second tick.
    const a = makeControlAdapter('thumbZones', DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    const p = raw.pointers[0]
    p.id = 1
    p.x = 200
    p.y = 200
    p.phase = 'down'
    raw.pointerCount = 1
    a.sample(raw, 0, out)
    raw.pointerCount = 0

    p.x = 256 // +56 px = half of the 112 px full-lock distance
    p.phase = 'move'
    raw.pointerCount = 1
    for (let t = 1; t <= 24; t++) {
      a.sample(raw, t, out)
      raw.pointerCount = 0
    }
    expect(out.steer).toBeCloseTo(0.5, 3)

    raw.keys.ArrowLeft = true
    a.sample(raw, 25, out)
    expect(out.steer).toBeGreaterThan(0.4) // touch still larger: |0.4999| > |-0.35|
    a.sample(raw, 26, out)
    expect(out.steer).toBeCloseTo(-0.5775, 9) // keyboard now larger
  })
})
