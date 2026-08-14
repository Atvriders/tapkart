import { describe, expect, it } from 'vitest'
import { v3, v3add, v3dot, v3len, v3scale } from '../src/vec3'
import { wrapAngle } from '../src/mathutil'

describe('v3', () => {
  it('builds a Vec3 with exactly x, y, z', () => {
    const a = v3(1, 2, 3)
    expect(a.x).toBe(1)
    expect(a.y).toBe(2)
    expect(a.z).toBe(3)
    expect(Object.keys(a)).toEqual(['x', 'y', 'z'])
  })
})

describe('v3add', () => {
  it('writes the sum into out and leaves both inputs untouched', () => {
    const a = v3(1, 2, 3)
    const b = v3(10, 20, 30)
    const out = v3(-999, -999, -999)
    v3add(a, b, out)
    // (1+10, 2+20, 3+30)
    expect(out.x).toBe(11)
    expect(out.y).toBe(22)
    expect(out.z).toBe(33)
    expect(a.x).toBe(1); expect(a.y).toBe(2); expect(a.z).toBe(3)
    expect(b.x).toBe(10); expect(b.y).toBe(20); expect(b.z).toBe(30)
  })

  it('is correct when out aliases a', () => {
    const a = v3(1, 2, 3)
    const b = v3(0.5, -2, 100)
    v3add(a, b, a)
    // (1+0.5, 2-2, 3+100)
    expect(a.x).toBe(1.5)
    expect(a.y).toBe(0)
    expect(a.z).toBe(103)
  })

  it('is correct when out aliases b and a and b are the same object', () => {
    const a = v3(2, 4, 8)
    v3add(a, a, a)
    // (2+2, 4+4, 8+8)
    expect(a.x).toBe(4)
    expect(a.y).toBe(8)
    expect(a.z).toBe(16)
  })

  it('returns undefined (out-param style, never a fresh Vec3)', () => {
    const out = v3(0, 0, 0)
    expect(v3add(v3(1, 1, 1), v3(1, 1, 1), out)).toBeUndefined()
  })
})

describe('v3scale', () => {
  it('scales into out', () => {
    const a = v3(1, -2, 3)
    const out = v3(0, 0, 0)
    v3scale(a, -2, out)
    // (1*-2, -2*-2, 3*-2)
    expect(out.x).toBe(-2)
    expect(out.y).toBe(4)
    expect(out.z).toBe(-6)
    expect(a.x).toBe(1); expect(a.y).toBe(-2); expect(a.z).toBe(3)
  })

  it('is correct when out aliases a', () => {
    const a = v3(3, 6, 9)
    v3scale(a, 1 / 3, a)
    // 3*(1/3), 6*(1/3), 9*(1/3) are all exact in float64
    expect(a.x).toBe(1)
    expect(a.y).toBe(2)
    expect(a.z).toBe(3)
  })
})

describe('v3len', () => {
  it('is exact for pythagorean triples', () => {
    expect(v3len(v3(3, 0, 4))).toBe(5) // sqrt(9 + 0 + 16) = 5
    expect(v3len(v3(1, 2, 2))).toBe(3) // sqrt(1 + 4 + 4) = 3
    expect(v3len(v3(0, 0, 0))).toBe(0)
  })

  it('includes the y axis', () => {
    expect(v3len(v3(0, 5, 0))).toBe(5)
  })
})

describe('v3dot', () => {
  it('is the sum of componentwise products', () => {
    expect(v3dot(v3(1, 2, 3), v3(4, 5, 6))).toBe(32)   // 4 + 10 + 18
    expect(v3dot(v3(-1, 0, 2), v3(3, 7, -4))).toBe(-11) // -3 + 0 - 8
  })

  it('is zero for perpendicular axis vectors', () => {
    expect(v3dot(v3(1, 0, 0), v3(0, 0, 1))).toBe(0)
  })
})

describe('contract conventions', () => {
  it('forward = (cos h, 0, sin h) points along +x at heading 0', () => {
    const h = 0
    const forward = v3(Math.cos(h), 0, Math.sin(h))
    expect(forward.x).toBe(1)
    expect(forward.y).toBe(0)
    expect(forward.z).toBe(0)
  })

  it('forward = (cos h, 0, sin h) points along +z at heading PI/2', () => {
    const h = Math.PI / 2
    const forward = v3(Math.cos(h), 0, Math.sin(h))
    // Math.cos(Math.PI / 2) is 6.123233995736766e-17, not exactly 0.
    expect(forward.x).toBeCloseTo(0, 15)
    // Math.sin(Math.PI / 2) is exactly 1.
    expect(forward.z).toBe(1)
  })

  it('h = atan2(dir.z, dir.x) recovers PI/2 for the +z direction', () => {
    const dir = v3(0, 0, 1)
    expect(Math.atan2(dir.z, dir.x)).toBe(Math.PI / 2)
  })

  it('a kart facing -x has heading exactly PI and wrapAngle keeps it there', () => {
    const dir = v3(-1, 0, 0)
    const h = Math.atan2(dir.z, dir.x)
    expect(h).toBe(Math.PI)
    // This is why the wrap range is (-PI, PI] and not [-PI, PI).
    expect(wrapAngle(h)).toBe(Math.PI)
  })

  it('right = (-t.z, 0, t.x) is +z for a track tangent along +x', () => {
    const t = v3(1, 0, 0)
    const right = v3(-t.z, 0, t.x)
    // -t.z is -0 here, so compare with === (which treats -0 as 0) rather
    // than toBe (which uses Object.is and would reject -0).
    expect(right.x === 0).toBe(true)
    expect(right.y).toBe(0)
    expect(right.z).toBe(1)
    expect(v3len(right)).toBe(1)
  })

  it('right = (-t.z, 0, t.x) is -x for a track tangent along +z', () => {
    const t = v3(0, 0, 1)
    const right = v3(-t.z, 0, t.x)
    expect(right.x).toBe(-1)
    expect(right.y).toBe(0)
    expect(right.z).toBe(0)
    expect(v3len(right)).toBe(1)
  })
})
