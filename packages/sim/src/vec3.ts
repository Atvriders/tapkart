import type { Vec3 } from './types'

/**
 * Allocates a Vec3. Setup only — never call this inside step().
 */
export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

/**
 * out = a + b. Safe when out aliases a or b, because all three components are
 * computed before any is written.
 */
export function v3add(a: Vec3, b: Vec3, out: Vec3): void {
  const x = a.x + b.x
  const y = a.y + b.y
  const z = a.z + b.z
  out.x = x
  out.y = y
  out.z = z
}

/**
 * out = a * s. Safe when out aliases a.
 */
export function v3scale(a: Vec3, s: number, out: Vec3): void {
  const x = a.x * s
  const y = a.y * s
  const z = a.z * s
  out.x = x
  out.y = y
  out.z = z
}

export function v3len(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
}

export function v3dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}
