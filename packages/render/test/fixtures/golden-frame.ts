// Test-only. It imports nothing but this package's own types, which is what lets
// the game-side test drive it without inverting the dependency arrow (§1).
import type { CameraState, EntityDraw, HudModel, KartDraw, RenderFrame } from '../../src/index'

type Vec3 = CameraState['position']

/** The repository-root-relative path of the recorded fixture. Resolved against
 *  process.cwd(), which vitest sets to the repo root. */
export const GOLDEN_FRAME_FILE = 'packages/render/test/fixtures/golden-frame.txt'

/** Every number in a FIELD VALUE, so two implementations cannot disagree about
 *  precision. `(-0).toFixed(6)` is '0.000000', which is what keeps a signed zero
 *  from flaking the fixture. */
function n(value: number): string {
  return value.toFixed(6)
}

/** `x,y,z`, each component through n(). */
function v(position: Vec3): string {
  return `${n(position.x)},${n(position.y)},${n(position.z)}`
}

/** Quoted, so an empty countdownLabel is `''` rather than nothing at all. */
function s(value: string): string {
  return `'${value}'`
}

/**
 * The covered subset, serialised deterministically (Q33): one line per record,
 * keys in the order below, every number via toFixed(6). Anything not listed is
 * NOT in the fixture.
 *
 * Format, stated exactly because the fixture is only worth having if two people
 * would produce the same bytes:
 *   - one record per line, lines joined by '\n', with a trailing '\n'
 *   - `<record> [<index>] <key>=<value> …`, single spaces throughout
 *   - the record's slot INDEX is a plain base-10 integer; every field VALUE that
 *     is a number goes through toFixed(6), including enum-valued integers such
 *     as driftSparkTier
 *   - booleans are `true` / `false`; strings are single-quoted
 *   - records in order: every kart slot, every entity slot, camera, hud, every
 *     item box
 *
 * COVERED (derived from simulation state): KartDraw playerId, visible, position,
 * heading, roll, wheelSpin, steerAngle, alpha, driftSparkTier, boostFlame,
 * shieldVisible; EntityDraw entityId, kind, visible, position, heading, scale;
 * the whole CameraState; HudModel place, lap, speedKph, countdownLabel,
 * raceClock; itemBoxAlpha.
 *
 * NOT COVERED (visual tuning this plan exists to tune by eye): bodyTint and
 * every palette, entity tint and alpha, screenFlash, screenTintColor,
 * screenTintAmount, marker spacing, bloom, fog, every theme number.
 */
export function serializeDerivedFrame(frame: RenderFrame, hud: HudModel): string {
  const out: string[] = []

  for (let i = 0; i < frame.karts.length; i++) {
    const kart: KartDraw = frame.karts[i]
    out.push(
      `kart ${i} playerId=${n(kart.playerId)} visible=${kart.visible} position=${v(kart.position)}`
        + ` heading=${n(kart.heading)} roll=${n(kart.roll)} wheelSpin=${n(kart.wheelSpin)}`
        + ` steerAngle=${n(kart.steerAngle)} alpha=${n(kart.alpha)}`
        + ` driftSparkTier=${n(kart.driftSparkTier)} boostFlame=${n(kart.boostFlame)}`
        + ` shieldVisible=${kart.shieldVisible}`,
    )
  }

  for (let j = 0; j < frame.entities.length; j++) {
    const entity: EntityDraw = frame.entities[j]
    out.push(
      `entity ${j} entityId=${n(entity.entityId)} kind=${s(entity.kind)} visible=${entity.visible}`
        + ` position=${v(entity.position)} heading=${n(entity.heading)} scale=${n(entity.scale)}`,
    )
  }

  const camera: CameraState = frame.camera
  out.push(
    `camera position=${v(camera.position)} lookAt=${v(camera.lookAt)} up=${v(camera.up)}`
      + ` fovDegrees=${n(camera.fovDegrees)} mode=${s(camera.mode)}`,
  )

  out.push(
    `hud place=${n(hud.place)} lap=${n(hud.lap)} speedKph=${n(hud.speedKph)}`
      + ` countdownLabel=${s(hud.countdownLabel)} raceClock=${s(hud.raceClock)}`,
  )

  for (let box = 0; box < frame.itemBoxAlpha.length; box++) {
    out.push(`itembox ${box} alpha=${n(frame.itemBoxAlpha[box])}`)
  }

  return `${out.join('\n')}\n`
}
