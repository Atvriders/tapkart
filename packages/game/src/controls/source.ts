import type { ControlInputs, InputSource, PointerPhase, TiltSample, Viewport } from './types'
import { MAX_POINTERS } from './types'

/**
 * Attaches pointer, key and deviceorientation listeners. The ONLY file in
 * packages/game that references a DOM event (§8.2), and the reason the rest of the
 * package is testable under `environment: 'node'` with no jsdom.
 *
 * `viewport` is owned by the CALLER - the shell updates it on resize and `drain`
 * copies it. One owner for the canvas size, and it is not this module.
 *
 * `target` is the element the shell listens on; it passes `window` so that keys
 * and device orientation arrive alongside pointers.
 */
export function attachInputSource(target: EventTarget, viewport: Viewport): InputSource {
  // Fixed-size accumulator, allocated once. A frame that produces more than
  // MAX_POINTERS events drops the excess rather than growing an array in the
  // input path (§7.3).
  const ids = new Int32Array(MAX_POINTERS)
  const xs = new Float64Array(MAX_POINTERS)
  const ys = new Float64Array(MAX_POINTERS)
  const phases: PointerPhase[] = []
  for (let i = 0; i < MAX_POINTERS; i++) phases.push('up')
  let count = 0

  const keys: Record<string, boolean> = {}
  const tiltScratch: TiltSample = { alpha: 0, beta: 0, gamma: 0 }
  let haveTilt = false

  function push(id: number, x: number, y: number, phase: PointerPhase): void {
    if (count >= MAX_POINTERS) return
    ids[count] = id
    xs[count] = x
    ys[count] = y
    phases[count] = phase
    count++
  }

  function pointerHandler(phase: PointerPhase): (e: Event) => void {
    return (e: Event): void => {
      const p = e as PointerEvent
      // clientX/clientY are CSS px from the viewport's left/top edge, which is
      // exactly what PointerSample documents.
      push(p.pointerId, p.clientX, p.clientY, phase)
      if (e.cancelable) e.preventDefault()
    }
  }

  const onDown = pointerHandler('down')
  const onMove = pointerHandler('move')
  const onUp = pointerHandler('up')
  // A cancelled touch (a system gesture, an incoming call) never produces
  // 'pointerup'. Without this line the drift button stays latched for the rest of
  // the race and the player cannot release it.
  const onCancel = pointerHandler('up')

  const onKeyDown = (e: Event): void => {
    keys[(e as KeyboardEvent).code] = true
  }
  const onKeyUp = (e: Event): void => {
    keys[(e as KeyboardEvent).code] = false
  }
  // A key released while the window is unfocused never delivers 'keyup'. Clearing
  // on blur is what stops the kart driving itself after an alt-tab.
  const onBlur = (): void => {
    for (const code of Object.keys(keys)) keys[code] = false
  }

  const onOrientation = (e: Event): void => {
    const d = e as DeviceOrientationEvent
    if (d.alpha === null || d.beta === null || d.gamma === null) return
    if (!Number.isFinite(d.alpha) || !Number.isFinite(d.beta) || !Number.isFinite(d.gamma)) return
    tiltScratch.alpha = d.alpha
    tiltScratch.beta = d.beta
    tiltScratch.gamma = d.gamma
    haveTilt = true
  }

  target.addEventListener('pointerdown', onDown)
  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', onUp)
  target.addEventListener('pointercancel', onCancel)
  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('blur', onBlur)
  target.addEventListener('deviceorientation', onOrientation)

  return {
    drain(out: ControlInputs): void {
      for (let i = 0; i < count; i++) {
        const p = out.pointers[i]
        p.id = ids[i]
        p.x = xs[i]
        p.y = ys[i]
        p.phase = phases[i]
      }
      out.pointerCount = count
      count = 0

      // `keys` and `tiltScratch` are LEVELS, not edges: they persist across frames
      // and the adapters only read them. Aliasing rather than copying is what keeps
      // drain() allocation-free.
      out.keys = keys
      out.tilt = haveTilt ? tiltScratch : null
      out.viewport.width = viewport.width
      out.viewport.height = viewport.height
    },

    snapshotTilt(out: TiltSample): boolean {
      if (!haveTilt) return false
      out.alpha = tiltScratch.alpha
      out.beta = tiltScratch.beta
      out.gamma = tiltScratch.gamma
      return true
    },

    detach(): void {
      target.removeEventListener('pointerdown', onDown)
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onCancel)
      target.removeEventListener('keydown', onKeyDown)
      target.removeEventListener('keyup', onKeyUp)
      target.removeEventListener('blur', onBlur)
      target.removeEventListener('deviceorientation', onOrientation)
    },
  }
}

/** iOS's motion permission gate, which exists only on iOS and only as a static
 *  method the DOM lib does not declare. */
interface MotionPermissionGate {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>
}

/**
 * iOS requires a user-gesture-gated permission prompt for motion. Resolves `false`
 * when denied or unsupported.
 *
 * Q22: the CALLER reverts the selection and shows a reason; it does not silently
 * fall back. A player who selects tilt, is denied by the OS, and gets thumb-zones
 * with no explanation concludes the game is broken.
 */
export async function requestTiltPermission(): Promise<boolean> {
  const gate = (globalThis as { DeviceOrientationEvent?: MotionPermissionGate }).DeviceOrientationEvent
  if (gate === undefined) return false // no orientation API at all
  if (typeof gate.requestPermission !== 'function') return true // not iOS: no gate to pass
  try {
    return (await gate.requestPermission()) === 'granted'
  } catch {
    // iOS throws when the call is not inside a user gesture. That is a denial.
    return false
  }
}
