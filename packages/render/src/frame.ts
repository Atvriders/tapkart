// PURE (contract §0a): no DOM, no GPU, no clock, no `three` import, and nothing
// in the frame path allocates.
import type { EntityKind, Vec3 } from '@tapkart/sim'
import {
  CHARGE_TTL_TICKS,
  ITEM_BOOST_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  TICK_DT,
  clamp,
  v3,
  wrapAngle,
} from '@tapkart/sim'
import type { CharacterDescriptor, KartDescriptor, PaletteRGB, TrackTheme } from '@tapkart/content'
import type { CameraState } from './camera'
import { createCameraState } from './camera'
import type { RaceView } from './types'

export interface KartDraw {
  playerId: number
  characterIdx: number
  visible: boolean
  position: Vec3
  heading: number // radians - COPIED from KartView, never modified
  roll: number // radians: bankAngle + drift lean + spin-out tilt
  wheelSpin: number // radians, accumulated per SIM TICK, wrapped
  steerAngle: number // radians, front wheels
  bodyTint: PaletteRGB
  alpha: number // 0..1; invulnerability flickers this
  driftSparkTier: number // sim's encoding, copied from KartView.driftTier
  boostFlame: number // 0..1
  shieldVisible: boolean
}

export interface EntityDraw {
  entityId: number
  kind: EntityKind
  visible: boolean
  position: Vec3
  heading: number
  scale: number // metres; the adapter's unit sphere/box is scaled by this
  tint: PaletteRGB
  alpha: number // 0..1
}

export interface RenderFrame {
  camera: CameraState
  karts: KartDraw[] // length MAX_KARTS
  entities: EntityDraw[] // length MAX_ENTITIES
  entityCount: number
  itemBoxAlpha: Float32Array // length = itemBoxes.length; Q29
  screenFlash: number // 0..1, charge blast
  screenTintColor: PaletteRGB
  screenTintAmount: number // 0..1, surge slow
  /** The view tick this frame's accumulators were last advanced to. The ONLY
   *  field of `out` that buildRenderFrame reads besides KartDraw.wheelSpin. */
  sourceTick: number
}

/**
 * sim's BUBBLE_ORBIT_RADIUS, which is module-private in
 * packages/sim/src/entity.ts:12. It is declared here rather than imported
 * because `render` may not widen sim's exports, and it is protected from drift
 * by a REQUIRED test that re-derives it from real sim behaviour (§8.1). Do not
 * change one without the other.
 */
export const BUBBLE_ORBIT_RADIUS_M = 2.0

/** Roll added while drifting, times driftDir. */
export const KART_DRIFT_LEAN_RADIANS = 0.22
/** Roll added while spinOutTicks > 0. */
export const KART_SPINOUT_ROLL_RADIANS = 0.15
/** Front-wheel deflection at full lock. */
export const KART_STEER_VISUAL_MAX_RADIANS = 0.5
/** rad/s of angularVelocity that reads as full lock. */
export const KART_STEER_VISUAL_YAW_RATE = 2.6
/** 7.5 Hz at 60 Hz. */
export const INVULN_FLICKER_PERIOD_TICKS = 8
export const INVULN_FLICKER_ALPHA = 0.35
export const SURGE_TINT: PaletteRGB = [0.35, 0.15, 0.55]
export const SURGE_TINT_AMOUNT = 0.28
export const CHARGE_FLASH_RADIUS_M = 20

/**
 * Metres, per kind. seeker/bolt/slick/charge are sim's own strike radii
 * (hitRadiusFor, packages/sim/src/entity.ts:125-138), so the drawn object IS
 * the collision volume. A bubble has no strike radius - its collision role is
 * the owner's `shielded` flag - and it orbits at BUBBLE_ORBIT_RADIUS_M, so it
 * is a small orb rather than a sphere that swallows the kart. A surge is never
 * drawn at all (Q27): it has no meaningful location, and drawing a mesh at a
 * meaningless position is worse than drawing nothing, because players will try
 * to dodge it.
 */
export const ENTITY_SCALE: Readonly<Record<EntityKind, number>> = {
  seeker: 1.6,
  bolt: 1.4,
  slick: 1.2,
  bubble: 0.6,
  surge: 0,
  charge: 6.0,
}

/**
 * Every field zeroed, every Vec3 distinct, `sourceTick = 0`, `itemBoxAlpha`
 * filled with 1. Called once per session, never per frame.
 *
 * Two fields start at -1 rather than 0, because 0 is a real value in both
 * encodings: `driftSparkTier` uses sim's tier encoding, where -1 is "no
 * mini-turbo pending" and 0 is a real tier (§0), and `entityId` uses §4.2's
 * unused-slot sentinel.
 */
export function createRenderFrame(itemBoxCount: number): RenderFrame {
  const karts: KartDraw[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    karts.push({
      playerId: 0,
      characterIdx: 0,
      visible: false,
      position: v3(0, 0, 0),
      heading: 0,
      roll: 0,
      wheelSpin: 0,
      steerAngle: 0,
      bodyTint: [0, 0, 0],
      alpha: 0,
      driftSparkTier: -1,
      boostFlame: 0,
      shieldVisible: false,
    })
  }

  const entities: EntityDraw[] = []
  for (let j = 0; j < MAX_ENTITIES; j++) {
    entities.push({
      entityId: -1,
      kind: 'seeker',
      visible: false,
      position: v3(0, 0, 0),
      heading: 0,
      scale: 0,
      tint: [0, 0, 0],
      alpha: 0,
    })
  }

  const itemBoxAlpha = new Float32Array(Math.max(0, itemBoxCount))
  itemBoxAlpha.fill(1)

  return {
    camera: createCameraState(),
    karts,
    entities,
    entityCount: 0,
    itemBoxAlpha,
    screenFlash: 0,
    screenTintColor: [0, 0, 0],
    screenTintAmount: 0,
    sourceTick: 0,
  }
}

/**
 * Q28's bubble reconstruction, exported so the frame builder and its test call
 * one function. This is sim's formula verbatim (entity.ts:196-208), applied to
 * interpolated inputs: `out = ownerPosition + (cos h, 0, sin h) *
 * BUBBLE_ORBIT_RADIUS_M`, with `out.y = ownerPosition.y`.
 *
 * Safe when `out === ownerPosition`: no component is read after it is written.
 */
export function bubblePosition(ownerPosition: Vec3, heading: number, out: Vec3): void {
  out.x = ownerPosition.x + Math.cos(heading) * BUBBLE_ORBIT_RADIUS_M
  out.y = ownerPosition.y
  out.z = ownerPosition.z + Math.sin(heading) * BUBBLE_ORBIT_RADIUS_M
}

/**
 * True when a live surge field cast by a kart PLACED BEHIND `playerId` is
 * slowing it. Derived from the view alone (entity kind + ownerId +
 * KartView.place) so it works identically on a guest, where `state()` cannot be
 * consulted. Mirrors `surgeActiveOn` in @tapkart/sim - lower place index is
 * further ahead - and a test asserts they agree for every seat.
 */
export function surgeAffects(view: RaceView, playerId: number): boolean {
  if (playerId < 0 || playerId >= MAX_KARTS) return false
  const mine = view.karts[playerId].place
  for (let j = 0; j < view.entityCount; j++) {
    const e = view.entities[j]
    if (e.kind !== 'surge') continue
    if (e.ownerId === playerId) continue
    if (e.ownerId < 0 || e.ownerId >= MAX_KARTS) continue
    if (mine < view.karts[e.ownerId].place) return true
  }
  return false
}

/** ttl in ticks over which a dropped hazard fades out. Contract §4.7 states
 *  this row as `clamp(e.ttl / 30, 0, 1)`; the divisor is written once here. */
const HAZARD_FADE_TICKS = 30

/**
 * THE pure function of this package. (RaceView, CameraState, TrackTheme,
 * descriptors) -> RenderFrame. No clock, no DOM, no allocation, no randomness.
 * SOLE WRITER of every RenderFrame field.
 *
 * It reads exactly two things out of `out`: `out.sourceTick` and
 * `out.karts[i].wheelSpin`. Every other field of `out` is write-only. That is
 * what makes wheel rotation frame-rate independent while keeping the function a
 * deterministic function of (inputs, prior accumulator).
 *
 * `characters` and `karts` are both length 8, indexed by characterIdx (§4.4).
 * Karts are filled BEFORE entities, because a bubble is reconstructed from its
 * owner's already-resolved KartDraw.position (Q28).
 */
export function buildRenderFrame(
  view: RaceView,
  cam: CameraState,
  theme: TrackTheme,
  characters: readonly CharacterDescriptor[],
  karts: readonly KartDescriptor[],
  out: RenderFrame,
): void {
  // --- camera, copied by value: updateCamera keeps mutating `cam` after this
  // frame has been handed to the backend.
  out.camera.position.x = cam.position.x
  out.camera.position.y = cam.position.y
  out.camera.position.z = cam.position.z
  out.camera.lookAt.x = cam.lookAt.x
  out.camera.lookAt.y = cam.lookAt.y
  out.camera.lookAt.z = cam.lookAt.z
  out.camera.up.x = cam.up.x
  out.camera.up.y = cam.up.y
  out.camera.up.z = cam.up.z
  out.camera.fovDegrees = cam.fovDegrees
  out.camera.mode = cam.mode

  // Sim ticks elapsed since this frame's accumulators were last advanced. Never
  // negative: a view that goes backwards (a reset, a rejoin) holds the wheels.
  const dt = Math.max(0, view.tick - out.sourceTick)
  const flickerOn =
    view.tick % INVULN_FLICKER_PERIOD_TICKS >= INVULN_FLICKER_PERIOD_TICKS / 2

  // --- karts, by seat
  const kartDescCount = karts.length
  const charDescCount = characters.length
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = view.karts[i]
    const d = out.karts[i]
    // The frame path must be total: a descriptor index is clamped rather than
    // trusted, so a malformed session cannot throw inside the render loop.
    const kd = karts[clamp(Math.trunc(k.characterIdx), 0, kartDescCount - 1)]

    d.playerId = k.playerId
    d.characterIdx = k.characterIdx
    d.visible = k.source !== 'absent'
    d.position.x = k.position.x
    d.position.y = k.position.y
    d.position.z = k.position.z
    d.heading = k.heading
    d.roll =
      k.bankAngle +
      (k.driftActive ? KART_DRIFT_LEAN_RADIANS * k.driftDir : 0) +
      (k.spinOutTicks > 0 ? KART_SPINOUT_ROLL_RADIANS : 0)
    d.wheelSpin = wrapAngle(d.wheelSpin + (k.speed / kd.wheelRadius) * TICK_DT * dt)
    d.steerAngle =
      clamp(k.angularVelocity / KART_STEER_VISUAL_YAW_RATE, -1, 1) *
      KART_STEER_VISUAL_MAX_RADIANS
    d.bodyTint = kd.palette.body
    d.alpha = k.invulnTicks > 0 && flickerOn ? INVULN_FLICKER_ALPHA : 1
    d.driftSparkTier = k.driftTier
    d.boostFlame = clamp(k.boostTicks / ITEM_BOOST_TICKS, 0, 1)
    d.shieldVisible = k.shielded
  }

  // --- entities, after karts
  for (let j = 0; j < MAX_ENTITIES; j++) {
    const e = view.entities[j]
    const d = out.entities[j]
    const live = j < view.entityCount
    const ownerSeat = e.ownerId >= 0 && e.ownerId < MAX_KARTS ? e.ownerId : -1

    d.entityId = e.entityId
    d.kind = e.kind
    d.visible = live && e.kind !== 'surge'
    if (live && e.kind === 'bubble' && ownerSeat >= 0) {
      // Q28: rebuild from the owner's DRAWN position and the interpolated
      // heading. Lerping the sampled positions chords across the orbit.
      bubblePosition(out.karts[ownerSeat].position, e.heading, d.position)
    } else {
      d.position.x = e.position.x
      d.position.y = e.position.y
      d.position.z = e.position.z
    }
    d.heading = e.heading
    d.scale = ENTITY_SCALE[e.kind]
    d.tint =
      ownerSeat >= 0
        ? characters[
            clamp(Math.trunc(view.karts[ownerSeat].characterIdx), 0, charDescCount - 1)
          ].palette.accent
        : theme.edgeMarkers.colors[0]
    d.alpha =
      e.kind === 'slick' || e.kind === 'charge' ? clamp(e.ttl / HAZARD_FADE_TICKS, 0, 1) : 1
  }
  out.entityCount = view.entityCount

  // --- item boxes (Q29): ghosted, never hidden
  const denom = view.itemBoxRespawnTicks
  const boxCount = Math.min(out.itemBoxAlpha.length, view.itemBoxes.length)
  for (let b = 0; b < boxCount; b++) {
    out.itemBoxAlpha[b] =
      denom > 0 ? clamp(1 - view.itemBoxes[b].respawnTicks / denom, 0, 1) : 1
  }

  // --- screen effects
  const pid = view.localPlayerId
  const hasSeat = pid >= 0 && pid < MAX_KARTS
  let flash = 0
  if (hasSeat) {
    const lp = out.karts[pid].position
    for (let j = 0; j < view.entityCount; j++) {
      const e = view.entities[j]
      if (e.kind !== 'charge') continue
      const dx = e.position.x - lp.x
      const dy = e.position.y - lp.y
      const dz = e.position.z - lp.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const v =
        clamp(1 - dist / CHARGE_FLASH_RADIUS_M, 0, 1) * clamp(e.ttl / CHARGE_TTL_TICKS, 0, 1)
      if (v > flash) flash = v
    }
  }
  out.screenFlash = flash
  out.screenTintColor = SURGE_TINT
  out.screenTintAmount = hasSeat && surgeAffects(view, pid) ? SURGE_TINT_AMOUNT : 0

  // Last (§4.7): every wheelSpin above consumed the OLD value.
  out.sourceTick = view.tick
}
