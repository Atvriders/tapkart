import type { Intent } from '@tapkart/sim'

/**
 * THREE schemes (spec §1: "3, selectable (plus keyboard for desktop)").
 * Keyboard is NOT a fourth: Q23 rules it a merge, not an alternative.
 */
export type ControlScheme = 'thumbZones' | 'tilt' | 'virtualStick'

export type PointerPhase = 'down' | 'move' | 'up'

export interface PointerSample {
  id: number // the browser's pointerId; stable for one touch
  x: number // CSS px from the viewport's left edge
  y: number // CSS px from the viewport's TOP edge
  phase: PointerPhase
}

export interface TiltSample { alpha: number; beta: number; gamma: number } // degrees

export interface Viewport { width: number; height: number } // CSS px

/**
 * Unusable margins the viewport reports but the player cannot reach or see: a
 * display cutout, a rounded corner, a gesture bar. CSS px, one per edge.
 *
 * These are NOT subtracted from `Viewport`. Pointer coordinates arrive in full
 * viewport space, so shrinking the viewport would move every hit rect away from
 * the affordance drawn for it. Layout consumes the two together instead.
 */
export interface Insets { top: number; right: number; bottom: number; left: number } // CSS px

export const MAX_POINTERS = 8

/**
 * Raw, device-shaped input for ONE frame. Filled by the DOM source (§5.6) or by a
 * test, and consumed by exactly one ControlAdapter. `pointers` is fixed length
 * MAX_POINTERS; only [0, pointerCount) is live.
 */
export interface ControlInputs {
  pointers: PointerSample[]
  pointerCount: number
  keys: Record<string, boolean> // KeyboardEvent.code, e.g. 'ArrowLeft', 'KeyZ'
  tilt: TiltSample | null // null when unavailable or not permitted
  viewport: Viewport
  insets: Insets
}

/** Boundary between browser input events and the deterministic control layer.
 * `snapshotTilt` copies the newest complete sensor reading into caller-owned
 * storage; calibration can therefore take one atomic sample without retaining
 * a mutable event object. */
export interface InputSource {
  drain(out: ControlInputs): void
  snapshotTilt(out: TiltSample): boolean
  detach(): void
}

/**
 * Allocates one ControlInputs with every pointer slot a DISTINCT object. Called
 * once, at startup: the drain path (§5.6) and every adapter reuse it forever, so
 * nothing in the frame path allocates.
 */
export function createControlInputs(): ControlInputs {
  const pointers: PointerSample[] = []
  for (let i = 0; i < MAX_POINTERS; i++) pointers.push({ id: -1, x: 0, y: 0, phase: 'up' })
  return {
    pointers,
    pointerCount: 0,
    keys: {},
    tilt: null,
    viewport: { width: 0, height: 0 },
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
  }
}

/**
 * Every scheme is one of these and nothing more. Spec §6: "three schemes is three
 * small adapters, not three control systems."
 */
export interface ControlAdapter {
  readonly scheme: ControlScheme
  /**
   * Pure over (raw, tick, this adapter's own latched state). SOLE WRITER of `out`,
   * and it writes EVERY field of `out` including `out.tick = tick`.
   */
  sample(raw: ControlInputs, tick: number, out: Intent): void
  /**
   * Drops all latched state: drift hold, brake hold counter, stick origin, pointer
   * ids, item edge latch.
   */
  reset(): void
}
