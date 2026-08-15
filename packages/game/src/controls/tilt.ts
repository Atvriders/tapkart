import type { Intent } from '@tapkart/sim'
import { DRIFT_STEER_MIN, clamp, lerp } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs, TiltSample } from './types'
import type { ControlConfig, Rect } from './config'
import { BRAKE_HOLD_TICKS, driftButtonRect, itemButtonRect, rectContains } from './config'

export interface TiltCalibration { betaZero: number; gammaZero: number } // degrees

export const IDENTITY_TILT_CALIBRATION: Readonly<TiltCalibration> = { betaZero: 0, gammaZero: 0 }

/** Pure: the sample the player held while the calibration prompt was up. */
export function calibrateTilt(sample: TiltSample): TiltCalibration {
  return { betaZero: sample.beta, gammaZero: sample.gamma }
}

/**
 * Tilt steering with the thumbZones button layout (spec §6, offered not default).
 *
 * `gamma` is roll, which is the axis a phone held in landscape rotates about when
 * the player steers. The neutral point is `cfg.tiltCalibration.gammaZero`, written
 * by `calibrateTilt` from the sample the player held during calibration - which is
 * why `cfg.tiltNeutralDegrees` is not read here: the calibration IS the neutral,
 * and adding a second offset would give one fact two owners.
 *
 * `tilt === null` (unsupported, or Q22's permission denied) steers straight. It
 * never silently falls back to another scheme: that decision belongs to the
 * settings screen, which reverts the selection and says why.
 */
export function makeTiltAdapter(cfg: ControlConfig): ControlAdapter {
  const driftRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const itemRect: Rect = { x: 0, y: 0, w: 0, h: 0 }

  let driftId = -1
  let itemId = -1
  let driftHeldTicks = 0
  let steer = 0

  return {
    scheme: 'tilt',

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      driftButtonRect(raw.viewport, driftRect)
      itemButtonRect(raw.viewport, itemRect)

      let itemPulse = false

      for (let i = 0; i < raw.pointerCount; i++) {
        const p = raw.pointers[i]
        if (p.phase === 'down') {
          if (rectContains(driftRect, p.x, p.y)) {
            if (driftId === -1) driftId = p.id
          } else if (rectContains(itemRect, p.x, p.y)) {
            if (itemId === -1) {
              itemId = p.id
              itemPulse = true
            }
          }
          // No steering zone in this scheme, and the gap belongs to neither button.
        } else if (p.phase === 'up') {
          if (p.id === driftId) driftId = -1
          if (p.id === itemId) itemId = -1
        }
      }

      let axis = 0
      if (raw.tilt !== null && cfg.tiltRangeDegrees > 0) {
        axis = clamp((raw.tilt.gamma - cfg.tiltCalibration.gammaZero) / cfg.tiltRangeDegrees, -1, 1)
        if (cfg.invertTilt) axis = -axis
      }
      if (Math.abs(axis) < cfg.deadZone) axis = 0
      const target = clamp(axis * cfg.steerGain, -1, 1)
      steer = clamp(lerp(steer, target, cfg.steerSmoothingPerTick), -1, 1)

      const drift = driftId !== -1
      driftHeldTicks = drift ? driftHeldTicks + 1 : 0

      out.tick = tick
      out.steer = steer
      out.accel = 1
      out.brake = driftHeldTicks >= BRAKE_HOLD_TICKS && Math.abs(steer) < DRIFT_STEER_MIN
      out.drift = drift
      out.useItem = itemPulse
    },

    reset(): void {
      driftId = -1
      itemId = -1
      driftHeldTicks = 0
      steer = 0
    },
  }
}
