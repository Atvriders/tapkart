### Task 11b: `buildRenderFrame` — the derived-field table

The second half of `packages/render/src/frame.ts` (contract §4.7). Task 11
created the file, the structs, the eleven constants and the two sim-mirroring
helpers; this task adds **the** pure function of the package: `(RaceView,
CameraState, TrackTheme, descriptors) -> RenderFrame`.

**Files:**
- Modify: `packages/render/src/frame.ts` (append; imports at the top are widened)
- Test: `packages/render/test/frame-build.test.ts`

**Interfaces:**

- Consumes, from `packages/render/src/frame.ts` (Task 11):
  ```ts
  export interface KartDraw { playerId: number; characterIdx: number; visible: boolean
    position: Vec3; heading: number; roll: number; wheelSpin: number; steerAngle: number
    bodyTint: PaletteRGB; alpha: number; driftSparkTier: number; boostFlame: number
    shieldVisible: boolean }
  export interface EntityDraw { entityId: number; kind: EntityKind; visible: boolean
    position: Vec3; heading: number; scale: number; tint: PaletteRGB; alpha: number }
  export interface RenderFrame { camera: CameraState; karts: KartDraw[]
    entities: EntityDraw[]; entityCount: number; itemBoxAlpha: Float32Array
    screenFlash: number; screenTintColor: PaletteRGB; screenTintAmount: number
    sourceTick: number }
  export function createRenderFrame(itemBoxCount: number): RenderFrame
  export function bubblePosition(ownerPosition: Vec3, heading: number, out: Vec3): void
  export function surgeAffects(view: RaceView, playerId: number): boolean
  export const BUBBLE_ORBIT_RADIUS_M = 2.0
  export const KART_DRIFT_LEAN_RADIANS = 0.22
  export const KART_SPINOUT_ROLL_RADIANS = 0.15
  export const KART_STEER_VISUAL_MAX_RADIANS = 0.5
  export const KART_STEER_VISUAL_YAW_RATE = 2.6
  export const INVULN_FLICKER_PERIOD_TICKS = 8
  export const INVULN_FLICKER_ALPHA = 0.35
  export const SURGE_TINT: PaletteRGB
  export const SURGE_TINT_AMOUNT = 0.28
  export const CHARGE_FLASH_RADIUS_M = 20
  export const ENTITY_SCALE: Readonly<Record<EntityKind, number>>
  ```
- Consumes, from `@tapkart/sim` (contract §2.1, §2.2):
  ```ts
  export const TICK_DT = 1 / 60
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export function clamp(v: number, lo: number, hi: number): number
  export function wrapAngle(a: number): number
  export const ITEM_BOOST_TICKS = 90
  export const CHARGE_TTL_TICKS = 20
  export function v3(x: number, y: number, z: number): Vec3
  ```
- Consumes, from `@tapkart/content` (contract §3a.3, §3a.4):
  ```ts
  export type PaletteRGB = readonly [number, number, number]
  export interface CharacterDescriptor { id: string; name: string; bodyHeight: number
    bodyRadius: number; headRadius: number
    palette: { primary: PaletteRGB; secondary: PaletteRGB; accent: PaletteRGB }
    silhouette: 'compact' | 'tall' | 'wide' }
  export interface KartDescriptor { id: string; name: string; chassisLength: number
    chassisWidth: number; chassisHeight: number; wheelRadius: number; wheelWidth: number
    palette: { body: PaletteRGB; trim: PaletteRGB; wheel: PaletteRGB } }
  export interface EdgeMarkerParams { spacing: number; height: number; offset: number
    colors: readonly [PaletteRGB, PaletteRGB] }
  export interface TrackTheme { trackId: string; road: PaletteRGB; roadDirt: PaletteRGB
    shoulder: PaletteRGB; wall: PaletteRGB; ground: PaletteRGB
    sky: { top: PaletteRGB; bottom: PaletteRGB }
    fog: { color: PaletteRGB; near: number; far: number }
    sunDirection: Vec3; ambient: number; edgeMarkers: EdgeMarkerParams }
  ```
- Consumes, from `packages/render/src/types.ts` (§4.2) and `src/camera.ts` (§4.6):
  `RaceView`, `KartView`, `EntityView`, `ItemBoxView`, `createRaceView(itemBoxCount)`,
  `CameraState`, `createCameraState()` — full field lists are in Task 11's
  `Interfaces` block and in contract §4.2 / §4.6.
- Consumes, from `packages/render/test/fixtures/render-fixtures.ts` (§9.1):
  ```ts
  export function makeThemeFixture(): TrackTheme
  export function makeCharacterDescriptorFixture(): CharacterDescriptor
  export function makeKartDescriptorFixture(): KartDescriptor
  ```
- Produces:
  ```ts
  export function buildRenderFrame(view: RaceView, cam: CameraState, theme: TrackTheme,
                                   characters: readonly CharacterDescriptor[],
                                   karts: readonly KartDescriptor[],
                                   out: RenderFrame): void
  ```
  Called once per animation frame by `startShell` (§5.13), immediately before
  `renderer.applyFrame(frame)`.

**Preconditions a reader must not misread**

- **`buildRenderFrame` reads the CURRENT view only.** The session allocates two
  `RaceView`s and alternates them per frame (Task 13 explains why: the audio
  model needs a previous view; the swap is owned by the session/shell tasks).
  That alternation does not reach this function: it takes whichever view is
  current, and its two accumulators — `out.sourceTick` and
  `out.karts[i].wheelSpin` — live on the `RenderFrame`, which is allocated once
  and never swapped.
- **It reads exactly two things out of `out`**: `out.sourceTick` and
  `out.karts[i].wheelSpin`. Every other field of `out` is write-only. That is
  what makes wheel rotation frame-rate independent while keeping the function a
  deterministic function of (inputs, prior accumulator).
- **`characters` and `karts` are both length 8, indexed by `characterIdx`** —
  never by seat. `KART_DESCRIPTORS[i]` is the kart of `CHARACTER_DESCRIPTORS[i]`
  (§3a.3).
- **Karts are filled before entities**, because a bubble's position is
  reconstructed from its owner's already-resolved `KartDraw.position`.

**The derived-field table, copied from contract §4.7 verbatim.** `k` is
`view.karts[i]`, `dt = max(0, view.tick - out.sourceTick)`:

| Field | Value |
|---|---|
| `visible` | `k.source !== 'absent'` |
| `position` | copied from `k.position` |
| `heading` | copied from `k.heading`, **unmodified** |
| `roll` | `k.bankAngle + (k.driftActive ? KART_DRIFT_LEAN_RADIANS * k.driftDir : 0) + (k.spinOutTicks > 0 ? KART_SPINOUT_ROLL_RADIANS : 0)` |
| `wheelSpin` | `wrapAngle(prevWheelSpin + (k.speed / karts[k.characterIdx].wheelRadius) * TICK_DT * dt)` |
| `steerAngle` | `clamp(k.angularVelocity / KART_STEER_VISUAL_YAW_RATE, -1, 1) * KART_STEER_VISUAL_MAX_RADIANS` |
| `bodyTint` | `karts[k.characterIdx].palette.body` |
| `alpha` | `k.invulnTicks > 0 && (view.tick % INVULN_FLICKER_PERIOD_TICKS) >= INVULN_FLICKER_PERIOD_TICKS / 2 ? INVULN_FLICKER_ALPHA : 1` |
| `driftSparkTier` | copied from `k.driftTier` |
| `boostFlame` | `clamp(k.boostTicks / ITEM_BOOST_TICKS, 0, 1)` |
| `shieldVisible` | `k.shielded` |
| `itemBoxAlpha[b]` | `clamp(1 - box.respawnTicks / view.itemBoxRespawnTicks, 0, 1)` |
| `screenFlash` | max over live `'charge'` entities of `clamp(1 - dist(e, localKart) / CHARGE_FLASH_RADIUS_M, 0, 1) * clamp(e.ttl / CHARGE_TTL_TICKS, 0, 1)`; 0 when `localPlayerId < 0` |
| `screenTintColor` | `SURGE_TINT` |
| `screenTintAmount` | `surgeAffects(view, view.localPlayerId) ? SURGE_TINT_AMOUNT : 0`; 0 when `localPlayerId < 0` |
| `entities[j].position` | `kind === 'bubble'` → `bubblePosition(ownerKartDraw.position, e.heading, out)`; otherwise copied from `e.position` |
| `entities[j].scale` | `ENTITY_SCALE[e.kind]` |
| `entities[j].visible` | `j < entityCount && e.kind !== 'surge'` |
| `entities[j].alpha` | `clamp(e.ttl / 30, 0, 1)` for `'slick'` and `'charge'`; 1 otherwise |
| `sourceTick` | `view.tick`, written last |

**Three rows that justify themselves** (§4.7, condensed):

- **`heading` is copied, never modified, and there is no `spinAngle`.** `sim`
  already spins a spun-out kart — `updateRecovery` writes `k.heading =
  wrapAngle(k.heading + SPIN_YAW_RATE * TICK_DT)` every tick
  (`packages/sim/src/recovery.ts:98-99`) and `heading` is on the wire. A
  render-side spin would double it. The only thing `render` adds to a spin-out
  is `KART_SPINOUT_ROLL_RADIANS` of tilt.
- **`surge` is never drawn (Q27).** `visible: false`, always. It reaches the
  player only as `screenTintAmount`.
- **Item boxes ghost rather than vanish (Q29).** `itemBoxAlpha` is a
  `Float32Array`, not a boolean array: a box that vanishes tells the player
  nothing, a box fading back in tells them exactly when it is worth driving over.

**The one field the contract does not state, decided here.** `EntityDraw.tint`
appears in the struct and in §9.2's *not covered by the golden frame* column, but
in no derived row. It is filled from data already in scope rather than from a
twelfth constant (the §11 census fixes `render/frame` at 18 exports, which the
eleven constants plus three structs plus four functions exactly consume):
**`tint` is the owner's character accent colour**, `characters[view.karts[e.ownerId].characterIdx].palette.accent`,
so a projectile carries the identity of whoever fired it — which is the only
information about an entity a player cannot get from its shape. When `ownerId` is
not a seat (no live entity has this, but the frame path must be total) it falls
back to `theme.edgeMarkers.colors[0]`, the one pair of colours a theme is
required to keep legible against its own ground.

**Not this task: the golden `RenderFrame` fixture.** Ruling Q33 places it in the
plan's **final** task, deliberately, so it freezes the visual constants *after*
they are tuned by eye. When it lands it will cover `buildRenderFrame`'s derived
geometry — `KartDraw`'s `playerId, visible, position, heading, roll, wheelSpin,
steerAngle, alpha, driftSparkTier, boostFlame, shieldVisible`, `EntityDraw`'s
`entityId, kind, visible, position, heading, scale`, the camera pose and
`itemBoxAlpha` — and **not** palettes, tints or `screenFlash`. Do not create it
here.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/frame-build.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { CharacterDescriptor, KartDescriptor } from '@tapkart/content'
import type { EntityKind, ItemKind, Surface } from '@tapkart/sim'
import { CHARGE_TTL_TICKS, ITEM_BOOST_TICKS, MAX_KARTS, TICK_DT, wrapAngle } from '@tapkart/sim'
import type { EntityView, KartView, RaceView, ViewSource } from '../src/types'
import { createRaceView } from '../src/types'
import { createCameraState } from '../src/camera'
import type { RenderFrame } from '../src/frame'
import {
  BUBBLE_ORBIT_RADIUS_M,
  CHARGE_FLASH_RADIUS_M,
  ENTITY_SCALE,
  INVULN_FLICKER_ALPHA,
  INVULN_FLICKER_PERIOD_TICKS,
  KART_DRIFT_LEAN_RADIANS,
  KART_SPINOUT_ROLL_RADIANS,
  KART_STEER_VISUAL_MAX_RADIANS,
  KART_STEER_VISUAL_YAW_RATE,
  SURGE_TINT,
  SURGE_TINT_AMOUNT,
  buildRenderFrame,
  createRenderFrame,
} from '../src/frame'
import {
  makeCharacterDescriptorFixture,
  makeKartDescriptorFixture,
  makeThemeFixture,
} from './fixtures/render-fixtures'

const BOX_COUNT = 4
const RESPAWN_TICKS = 180

/**
 * Eight kart descriptors with a DISTINCT wheelRadius and body colour per index.
 * Distinctness is the whole point: a builder that indexes `karts` by seat
 * instead of by characterIdx produces a frame whose lengths, counts and types
 * are all correct, and only a per-index difference exposes it.
 */
function makeKartDescriptors(): KartDescriptor[] {
  const base = makeKartDescriptorFixture()
  const out: KartDescriptor[] = []
  for (let i = 0; i < 8; i++) {
    out.push({
      ...base,
      id: `kart-${i}`,
      wheelRadius: 0.2 + i * 0.02,
      palette: { body: [i / 8, 0.1, 0.2], trim: base.palette.trim, wheel: base.palette.wheel },
    })
  }
  return out
}

function makeCharacterDescriptors(): CharacterDescriptor[] {
  const base = makeCharacterDescriptorFixture()
  const out: CharacterDescriptor[] = []
  for (let i = 0; i < 8; i++) {
    out.push({
      ...base,
      id: `char-${i}`,
      palette: { primary: base.palette.primary, secondary: base.palette.secondary,
                 accent: [0.05 * i, 0.5, 0.9] },
    })
  }
  return out
}

const KARTS = makeKartDescriptors()
const CHARACTERS = makeCharacterDescriptors()
const THEME = makeThemeFixture()

/**
 * Fills a KartView completely. Every field is set explicitly, because the
 * derived table is a function of nearly all of them and a test must not inherit
 * defaults it does not control.
 */
function setKart(k: KartView, o: Partial<KartView> & { playerId: number }): void {
  k.playerId = o.playerId
  k.characterIdx = o.characterIdx ?? 0
  k.source = o.source ?? ('authoritative' as ViewSource)
  k.position.x = o.position?.x ?? 0
  k.position.y = o.position?.y ?? 0
  k.position.z = o.position?.z ?? 0
  k.heading = o.heading ?? 0
  k.velocity.x = o.velocity?.x ?? 0
  k.velocity.y = o.velocity?.y ?? 0
  k.velocity.z = o.velocity?.z ?? 0
  k.angularVelocity = o.angularVelocity ?? 0
  k.speed = o.speed ?? 0
  k.s = o.s ?? 0
  k.bankAngle = o.bankAngle ?? 0
  k.driftActive = o.driftActive ?? false
  k.driftDir = o.driftDir ?? 0
  k.driftCharge = o.driftCharge ?? 0
  k.driftTier = o.driftTier ?? -1
  k.airborne = o.airborne ?? false
  k.surface = o.surface ?? ('tarmac' as Surface)
  k.spinOutTicks = o.spinOutTicks ?? 0
  k.invulnTicks = o.invulnTicks ?? 0
  k.boostTicks = o.boostTicks ?? 0
  k.respawnTicks = o.respawnTicks ?? 0
  k.shielded = o.shielded ?? false
  k.item = o.item ?? ('none' as ItemKind)
  k.lap = o.lap ?? 0
  k.checkpointIdx = o.checkpointIdx ?? 0
  k.t = o.t ?? 0
  k.place = o.place ?? o.playerId
  k.isBot = o.isBot ?? false
  k.connected = o.connected ?? true
}

function setEntity(e: EntityView, o: Partial<EntityView> & { entityId: number; kind: EntityKind }): void {
  e.entityId = o.entityId
  e.kind = o.kind
  e.ownerId = o.ownerId ?? -1
  e.source = o.source ?? ('authoritative' as ViewSource)
  e.position.x = o.position?.x ?? 0
  e.position.y = o.position?.y ?? 0
  e.position.z = o.position?.z ?? 0
  e.velocity.x = 0
  e.velocity.y = 0
  e.velocity.z = 0
  e.heading = o.heading ?? 0
  e.ttl = o.ttl ?? 600
}

/** A view with eight seats filled, place === seat, no entities, no local seat. */
function baseView(): RaceView {
  const view = createRaceView(BOX_COUNT)
  view.tick = 100
  view.alpha = 0
  view.phase = 'racing'
  view.localPlayerId = 0
  view.raceStartTick = 0
  view.entityCount = 0
  view.itemBoxRespawnTicks = RESPAWN_TICKS
  view.finishTick = -1
  view.countdownTicksLeft = 0
  for (let i = 0; i < MAX_KARTS; i++) setKart(view.karts[i], { playerId: i, characterIdx: i })
  for (let b = 0; b < BOX_COUNT; b++) {
    view.itemBoxes[b].boxIdx = b
    view.itemBoxes[b].respawnTicks = 0
  }
  return view
}

function build(view: RaceView, out: RenderFrame): void {
  buildRenderFrame(view, createCameraState(), THEME, CHARACTERS, KARTS, out)
}

describe('buildRenderFrame - karts', () => {
  it('copies identity, visibility and the simple per-kart fields', () => {
    const view = baseView()
    setKart(view.karts[3], {
      playerId: 3,
      characterIdx: 6,
      position: { x: 12, y: 1.5, z: -4 },
      heading: 0.75,
      shielded: true,
      driftTier: 2,
      source: 'interpolated',
    })
    setKart(view.karts[4], { playerId: 4, characterIdx: 1, source: 'absent' })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)

    const d = out.karts[3]
    expect(d.playerId).toBe(3)
    expect(d.characterIdx).toBe(6)
    expect(d.visible).toBe(true)
    expect(d.position).toEqual({ x: 12, y: 1.5, z: -4 })
    expect(d.heading).toBe(0.75)
    expect(d.shieldVisible).toBe(true)
    expect(d.driftSparkTier).toBe(2)
    expect(out.karts[4].visible).toBe(false)
  })

  // Catches indexing the descriptor arrays by SEAT instead of by characterIdx -
  // the classic version of this bug looks right for the whole grid whenever
  // seat === characterIdx, which is exactly how a solo race is set up.
  it('takes bodyTint from karts[characterIdx], by reference', () => {
    const view = baseView()
    setKart(view.karts[2], { playerId: 2, characterIdx: 5 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[2].bodyTint).toBe(KARTS[5].palette.body)
    expect(out.karts[2].bodyTint).not.toBe(KARTS[2].palette.body)
  })

  it('rolls by bank plus drift lean times driftDir plus spin-out tilt', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, bankAngle: 0.1, driftActive: true, driftDir: -1 })
    setKart(view.karts[1], { playerId: 1, bankAngle: 0.1, driftActive: true, driftDir: 1 })
    setKart(view.karts[2], { playerId: 2, bankAngle: 0.1, spinOutTicks: 30 })
    setKart(view.karts[3], { playerId: 3, bankAngle: 0.1 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[0].roll).toBeCloseTo(0.1 - KART_DRIFT_LEAN_RADIANS, 12)
    expect(out.karts[1].roll).toBeCloseTo(0.1 + KART_DRIFT_LEAN_RADIANS, 12)
    expect(out.karts[2].roll).toBeCloseTo(0.1 + KART_SPINOUT_ROLL_RADIANS, 12)
    expect(out.karts[3].roll).toBeCloseTo(0.1, 12)
  })

  // The no-double-spin assertion (§8.1). sim already yaws a spun-out kart at
  // SPIN_YAW_RATE and puts heading on the wire; a render-side spin angle would
  // double it, which is Q28's mistake made on a different object.
  it('copies a spun-out kart’s heading unmodified', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, heading: -2.5, spinOutTicks: 45 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[0].heading).toBe(-2.5)
    expect(out.karts[0].roll).toBeCloseTo(KART_SPINOUT_ROLL_RADIANS, 12)
  })

  it('maps angularVelocity to steerAngle, saturating at full lock', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, angularVelocity: KART_STEER_VISUAL_YAW_RATE / 2 })
    setKart(view.karts[1], { playerId: 1, angularVelocity: KART_STEER_VISUAL_YAW_RATE * 4 })
    setKart(view.karts[2], { playerId: 2, angularVelocity: -KART_STEER_VISUAL_YAW_RATE * 4 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[0].steerAngle).toBeCloseTo(KART_STEER_VISUAL_MAX_RADIANS / 2, 12)
    expect(out.karts[1].steerAngle).toBeCloseTo(KART_STEER_VISUAL_MAX_RADIANS, 12)
    expect(out.karts[2].steerAngle).toBeCloseTo(-KART_STEER_VISUAL_MAX_RADIANS, 12)
  })

  it('flickers alpha on the stated period while invulnerable', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, invulnTicks: 40 })
    setKart(view.karts[1], { playerId: 1 })
    const half = INVULN_FLICKER_PERIOD_TICKS / 2
    const seen: number[] = []
    for (let t = 0; t < INVULN_FLICKER_PERIOD_TICKS; t++) {
      const out = createRenderFrame(BOX_COUNT)
      view.tick = t
      build(view, out)
      seen.push(out.karts[0].alpha)
      expect(out.karts[1].alpha).toBe(1)
      expect(out.karts[0].alpha).toBe(t % INVULN_FLICKER_PERIOD_TICKS >= half ? INVULN_FLICKER_ALPHA : 1)
    }
    // Non-vacuity: the kart must actually blink, not sit at one value.
    expect(new Set(seen).size).toBe(2)
  })

  it('ramps boostFlame to 1 at ITEM_BOOST_TICKS and clamps above it', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, boostTicks: 0 })
    setKart(view.karts[1], { playerId: 1, boostTicks: ITEM_BOOST_TICKS / 2 })
    setKart(view.karts[2], { playerId: 2, boostTicks: ITEM_BOOST_TICKS * 3 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[0].boostFlame).toBe(0)
    expect(out.karts[1].boostFlame).toBeCloseTo(0.5, 12)
    expect(out.karts[2].boostFlame).toBe(1)
  })
})

describe('buildRenderFrame - wheelSpin accumulator', () => {
  // The frame-rate independence assertion. A builder that accumulates per CALL
  // rather than per elapsed SIM TICK spins the wheels twice as fast on a 120 Hz
  // display as on a 60 Hz one - invisible to any single-call test.
  it('advances by elapsed sim ticks, not by calls', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, characterIdx: 3, speed: 20 })
    const out = createRenderFrame(BOX_COUNT)
    view.tick = 0
    build(view, out)
    expect(out.karts[0].wheelSpin).toBe(0)
    expect(out.sourceTick).toBe(0)

    // Two frames at the same tick: the second must add nothing.
    view.tick = 2
    build(view, out)
    const after2 = out.karts[0].wheelSpin
    build(view, out)
    expect(out.karts[0].wheelSpin).toBe(after2)

    const perTick = (20 / KARTS[3].wheelRadius) * TICK_DT
    expect(after2).toBeCloseTo(wrapAngle(perTick * 2), 12)

    view.tick = 5
    build(view, out)
    expect(out.karts[0].wheelSpin).toBeCloseTo(wrapAngle(after2 + perTick * 3), 12)
  })

  it('wraps rather than growing without bound', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, characterIdx: 0, speed: 40 })
    const out = createRenderFrame(BOX_COUNT)
    for (let t = 1; t <= 600; t++) {
      view.tick = t
      build(view, out)
      expect(Math.abs(out.karts[0].wheelSpin)).toBeLessThanOrEqual(Math.PI + 1e-9)
    }
    // Non-vacuity: a wheel that never turned would also stay inside the bound.
    expect(out.karts[0].wheelSpin).not.toBe(0)
  })

  it('never rewinds when the view tick goes backwards', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, speed: 10 })
    const out = createRenderFrame(BOX_COUNT)
    view.tick = 50
    build(view, out)
    const spin = out.karts[0].wheelSpin
    view.tick = 10
    build(view, out)
    expect(out.karts[0].wheelSpin).toBe(spin)
    expect(out.sourceTick).toBe(10)
  })
})

describe('buildRenderFrame - item boxes (Q29)', () => {
  // Catches the boolean-visibility implementation the ruling replaced: a box
  // that vanishes tells the player nothing.
  it('ghosts a respawning box in proportion to its timer', () => {
    const view = baseView()
    view.itemBoxes[0].respawnTicks = 0
    view.itemBoxes[1].respawnTicks = RESPAWN_TICKS / 2
    view.itemBoxes[2].respawnTicks = RESPAWN_TICKS
    view.itemBoxes[3].respawnTicks = RESPAWN_TICKS * 2
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.itemBoxAlpha[0]).toBeCloseTo(1, 6)
    expect(out.itemBoxAlpha[1]).toBeCloseTo(0.5, 6)
    expect(out.itemBoxAlpha[2]).toBeCloseTo(0, 6)
    expect(out.itemBoxAlpha[3]).toBeCloseTo(0, 6)
  })

  it('is total when the denominator is zero', () => {
    const view = baseView()
    view.itemBoxRespawnTicks = 0
    view.itemBoxes[0].respawnTicks = 0
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(Number.isNaN(out.itemBoxAlpha[0])).toBe(false)
  })
})

describe('buildRenderFrame - entities', () => {
  it('copies a plain entity and scales it by kind', () => {
    const view = baseView()
    setEntity(view.entities[0], {
      entityId: 11, kind: 'seeker', ownerId: 2, heading: 1.2,
      position: { x: 5, y: 0.5, z: 6 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entityCount).toBe(1)
    expect(out.entities[0].entityId).toBe(11)
    expect(out.entities[0].visible).toBe(true)
    expect(out.entities[0].position).toEqual({ x: 5, y: 0.5, z: 6 })
    expect(out.entities[0].heading).toBe(1.2)
    expect(out.entities[0].scale).toBe(ENTITY_SCALE.seeker)
    expect(out.entities[0].alpha).toBe(1)
  })

  // Q28's defect, made visible. The sampled position is deliberately WRONG -
  // it sits on the owner, which is what linear interpolation across the orbit
  // produces at its worst - and the frame must ignore it and rebuild from the
  // owner's drawn position plus the interpolated heading.
  it('reconstructs a bubble from its owner and heading, not from the sample', () => {
    const view = baseView()
    setKart(view.karts[4], { playerId: 4, characterIdx: 4, position: { x: 30, y: 2, z: -7 } })
    setEntity(view.entities[0], {
      entityId: 21, kind: 'bubble', ownerId: 4, heading: Math.PI / 2,
      position: { x: 30, y: 2, z: -7 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    const d = out.entities[0]
    expect(d.position.x).toBeCloseTo(30, 9)
    expect(d.position.y).toBeCloseTo(2, 9)
    expect(d.position.z).toBeCloseTo(-7 + BUBBLE_ORBIT_RADIUS_M, 9)
    expect(Math.hypot(d.position.x - 30, d.position.z + 7)).toBeCloseTo(BUBBLE_ORBIT_RADIUS_M, 9)
  })

  it('hugs the DRAWN owner, so the shield follows the kart the player sees', () => {
    const view = baseView()
    setKart(view.karts[4], { playerId: 4, position: { x: -50, y: 0, z: 12 } })
    setEntity(view.entities[0], {
      entityId: 22, kind: 'bubble', ownerId: 4, heading: 0,
      position: { x: 999, y: 999, z: 999 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].position.x).toBeCloseTo(-50 + BUBBLE_ORBIT_RADIUS_M, 9)
    expect(out.entities[0].position.y).toBeCloseTo(0, 9)
    expect(out.entities[0].position.z).toBeCloseTo(12, 9)
  })

  // Q27. Drawing a mesh at a meaningless position is worse than drawing
  // nothing, because players will try to dodge it.
  it('never makes a surge visible, however live it is', () => {
    const view = baseView()
    setEntity(view.entities[0], { entityId: 31, kind: 'surge', ownerId: 7, ttl: 300 })
    setEntity(view.entities[1], { entityId: 32, kind: 'bolt', ownerId: 7, ttl: 300 })
    view.entityCount = 2
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].visible).toBe(false)
    expect(out.entities[1].visible).toBe(true)
  })

  // Catches drawing the whole pool: slots at or past entityCount hold whatever
  // the last entity left there.
  it('marks slots at or past entityCount invisible', () => {
    const view = baseView()
    setEntity(view.entities[0], { entityId: 41, kind: 'bolt', ownerId: 1 })
    setEntity(view.entities[1], { entityId: -1, kind: 'bolt', ownerId: 1 })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].visible).toBe(true)
    expect(out.entities[1].visible).toBe(false)
    expect(out.entities[31].visible).toBe(false)
  })

  it('fades slick and charge by ttl, and nothing else', () => {
    const view = baseView()
    setEntity(view.entities[0], { entityId: 51, kind: 'slick', ownerId: 1, ttl: 15 })
    setEntity(view.entities[1], { entityId: 52, kind: 'charge', ownerId: 1, ttl: 60 })
    setEntity(view.entities[2], { entityId: 53, kind: 'bolt', ownerId: 1, ttl: 3 })
    view.entityCount = 3
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].alpha).toBeCloseTo(0.5, 12)
    expect(out.entities[1].alpha).toBe(1)
    expect(out.entities[2].alpha).toBe(1)
  })

  it('tints an entity with its owner’s character accent', () => {
    const view = baseView()
    setKart(view.karts[6], { playerId: 6, characterIdx: 2 })
    setEntity(view.entities[0], { entityId: 61, kind: 'bolt', ownerId: 6 })
    setEntity(view.entities[1], { entityId: 62, kind: 'slick', ownerId: -1 })
    view.entityCount = 2
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].tint).toBe(CHARACTERS[2].palette.accent)
    expect(out.entities[1].tint).toBe(THEME.edgeMarkers.colors[0])
  })
})

describe('buildRenderFrame - screen effects', () => {
  it('flashes hardest at the charge and not at all at its radius', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, position: { x: 0, y: 0, z: 0 } })
    setEntity(view.entities[0], {
      entityId: 71, kind: 'charge', ownerId: 3, ttl: CHARGE_TTL_TICKS,
      position: { x: 0, y: 0, z: 0 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(1, 12)

    view.entities[0].position.x = CHARGE_FLASH_RADIUS_M
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0, 12)

    view.entities[0].position.x = CHARGE_FLASH_RADIUS_M / 2
    view.entities[0].ttl = CHARGE_TTL_TICKS / 2
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0.25, 12)
  })

  it('takes the maximum over live charges and ignores dead slots', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, position: { x: 0, y: 0, z: 0 } })
    setEntity(view.entities[0], {
      entityId: 81, kind: 'charge', ownerId: 3, ttl: CHARGE_TTL_TICKS,
      position: { x: CHARGE_FLASH_RADIUS_M * 0.75, y: 0, z: 0 },
    })
    setEntity(view.entities[1], {
      entityId: 82, kind: 'charge', ownerId: 3, ttl: CHARGE_TTL_TICKS,
      position: { x: CHARGE_FLASH_RADIUS_M * 0.25, y: 0, z: 0 },
    })
    view.entityCount = 2
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0.75, 12)

    view.entityCount = 1
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0.25, 12)
  })

  it('is silent for a spectator with no local seat', () => {
    const view = baseView()
    view.localPlayerId = -1
    setEntity(view.entities[0], {
      entityId: 91, kind: 'charge', ownerId: 3, ttl: CHARGE_TTL_TICKS,
      position: { x: 0, y: 0, z: 0 },
    })
    setEntity(view.entities[1], { entityId: 92, kind: 'surge', ownerId: 7, ttl: 300 })
    view.entityCount = 2
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.screenFlash).toBe(0)
    expect(out.screenTintAmount).toBe(0)
  })

  it('tints the screen only while a surge from behind is slowing the local kart', () => {
    const view = baseView()
    view.localPlayerId = 1 // place 1
    setEntity(view.entities[0], { entityId: 93, kind: 'surge', ownerId: 5, ttl: 300 })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.screenTintColor).toBe(SURGE_TINT)
    expect(out.screenTintAmount).toBe(SURGE_TINT_AMOUNT)

    // Cast by a kart AHEAD of the local seat: no tint. Without this half, an
    // implementation that tints on any live surge passes the assertion above.
    view.entities[0].ownerId = 0
    build(view, out)
    expect(out.screenTintAmount).toBe(0)
  })
})

describe('buildRenderFrame - camera, sourceTick and allocation', () => {
  it('copies the camera pose by value, not by reference', () => {
    const view = baseView()
    const cam = createCameraState()
    cam.position.x = 3
    cam.position.y = 4
    cam.position.z = 5
    cam.lookAt.x = 1
    cam.fovDegrees = 71
    cam.mode = 'countdown'
    const out = createRenderFrame(BOX_COUNT)
    buildRenderFrame(view, cam, THEME, CHARACTERS, KARTS, out)
    expect(out.camera.position).toEqual({ x: 3, y: 4, z: 5 })
    expect(out.camera.lookAt.x).toBe(1)
    expect(out.camera.fovDegrees).toBe(71)
    expect(out.camera.mode).toBe('countdown')
    expect(out.camera).not.toBe(cam)
    expect(out.camera.position).not.toBe(cam.position)
    // A later updateCamera must not reach into a frame already handed to the
    // backend.
    cam.position.x = 999
    expect(out.camera.position.x).toBe(3)
  })

  it('writes sourceTick from the view', () => {
    const view = baseView()
    view.tick = 4242
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.sourceTick).toBe(4242)
  })

  // Scratch discipline (§7.3): the adapter may cache these objects between
  // frames, so the builder must write through them, never replace them.
  it('reuses every out object instead of allocating', () => {
    const view = baseView()
    const out = createRenderFrame(BOX_COUNT)
    const kartPos = out.karts[0].position
    const entPos = out.entities[0].position
    const camPos = out.camera.position
    const boxes = out.itemBoxAlpha
    const karts = out.karts
    setEntity(view.entities[0], { entityId: 1, kind: 'bolt', ownerId: 0 })
    view.entityCount = 1
    build(view, out)
    build(view, out)
    expect(out.karts[0].position).toBe(kartPos)
    expect(out.entities[0].position).toBe(entPos)
    expect(out.camera.position).toBe(camPos)
    expect(out.itemBoxAlpha).toBe(boxes)
    expect(out.karts).toBe(karts)
  })

  it('is deterministic: the same inputs and accumulator give the same frame', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, speed: 17, angularVelocity: 0.9, boostTicks: 30 })
    setEntity(view.entities[0], { entityId: 5, kind: 'bubble', ownerId: 0, heading: 1.1 })
    view.entityCount = 1
    const a = createRenderFrame(BOX_COUNT)
    const b = createRenderFrame(BOX_COUNT)
    build(view, a)
    build(view, b)
    expect(JSON.stringify(a.karts)).toBe(JSON.stringify(b.karts))
    expect(JSON.stringify(a.entities)).toBe(JSON.stringify(b.entities))
    expect(Array.from(a.itemBoxAlpha)).toEqual(Array.from(b.itemBoxAlpha))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/frame-build.test.ts`

Expected: FAIL — `frame.ts` exists (Task 11) but exports no `buildRenderFrame`:

```
SyntaxError: The requested module '<repo>/packages/render/src/frame.ts' does not provide an export named 'buildRenderFrame'
```

- [ ] **Step 3: Write the implementation**

Widen the import block at the top of `packages/render/src/frame.ts` — it becomes:

```ts
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
```

Then append to the same file:

```ts
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
```

`v3` and `createCameraState` stay used by `createRenderFrame`; nothing else in
the widened import block is unused, which `npm run typecheck` confirms under
`noUnusedLocals`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/frame-build.test.ts`
Expected: PASS, 27 tests.

Run: `npx vitest run packages/render/test/frame-core.test.ts`
Expected: still PASS, 14 tests — Task 11's file was appended to, not rewritten.

Run: `npm run typecheck --workspace @tapkart/render`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/frame.ts packages/render/test/frame-build.test.ts && git commit -m "feat(render): buildRenderFrame, the pure frame description

Every derived field is contract §4.7's expression: wheelSpin accumulates per
elapsed SIM TICK so a 120 Hz display does not double it, a bubble is rebuilt
from its owner's drawn position and interpolated heading rather than lerped
across its orbit (Q28), a surge is never visible and reaches the player only as
screenTintAmount (Q27), and item boxes ghost by respawn fraction instead of
vanishing (Q29)."
```
