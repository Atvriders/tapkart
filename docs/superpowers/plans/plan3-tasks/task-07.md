### Task 7: `packages/render` scaffold and `src/types.ts` — the view structs

The first Plan 3 package. Three things ship here and nothing else: the manifest (with
`three` pinned at **exactly `0.180.0`**, Q10), the tsconfig that widens `lib` to include
DOM in this package only (R35), and `src/types.ts` — the view structs that are the
**entire `game` → `render` handoff** (contract §4.2). `render` is handed views, never a
`SimState`; that is what makes spec §5's "remote karts render from the interpolated
buffer, never from prediction" a structural fact rather than a discipline.

This task also creates `packages/render/test/fixtures/render-fixtures.ts` — the full
§9.1 fixture surface — because every later `render` task imports it and it cannot be
written before `src/types.ts` exists. **Later render tasks import it; they do not
re-create it.**

**Prerequisite:** `@tapkart/content` must already export `CharacterDescriptor`,
`KartDescriptor` and `TrackTheme` (contract §3a.3, §3a.4) and have its `package.json`
in the workspace. If `npm install` cannot resolve `@tapkart/content`, that package's
task has not landed and this task stops rather than inventing a local copy.

**Files:**
- Create: `packages/render/package.json`
- Create: `packages/render/tsconfig.json`
- Create: `packages/render/src/types.ts`
- Create: `packages/render/src/index.ts`
- Create: `packages/render/test/fixtures/render-fixtures.ts`
- Modify: `package-lock.json` — `npm install` side effect (Step 3), declared because five tasks in this plan rewrite it
- Test: `packages/render/test/types.test.ts`
- Test: `packages/render/test/fixtures.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim` (its barrel re-exports all 19 modules):
  ```ts
  export type Vec3 = { x: number; y: number; z: number }
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'
  export type ItemKind =
    | 'none' | 'boost' | 'seeker' | 'bolt' | 'slick'
    | 'bubble' | 'surge' | 'blink' | 'charge'
  export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
  export type RacePhase = 'countdown' | 'racing' | 'finished'
  export interface Track { id: string; name: string; controlPoints: TrackPoint[]
    checkpointS: number[]; itemBoxes: { s: number; lateral: number }[]
    ramps: { sStart: number; sEnd: number; launch: number }[]
    boostPads: { s: number; lateral: number; halfWidth: number }[]
    startPositions: { s: number; lateral: number }[]
    bounds: { min: Vec3; max: Vec3 } }
  export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning
    characters: CharacterStats[]; isLeader: boolean }
  export function validateTrack(track: Track): string[]   // [] when valid
  export function v3(x: number, y: number, z: number): Vec3
  ```
- Consumes, from `@tapkart/content` (contract §3a.3, §3a.4 — an earlier task):
  ```ts
  export type PaletteRGB = readonly [number, number, number]     // linear, 0..1
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
- Consumes, by **relative path only** (contract §2.6 — sim's fixtures are outside
  `@tapkart/sim`'s `exports` map, and `src` never reaches them):
  ```ts
  // packages/sim/test/fixtures/track-fixtures.ts
  export function makeOvalTrack(overrides?: Partial<Track>): Track
  export function makeContext(track: Track, isLeader?: boolean): SimContext
  ```
- Produces — the 8 exports of `render/types` (contract §11's census for this module):
  ```ts
  export type ViewRole = 'host' | 'guest' | 'solo'
  export type ViewSource = 'authoritative' | 'predicted' | 'interpolated' | 'absent'
  export interface KartView { /* 28 fields, §4.2, verbatim below */ }
  export interface EntityView { /* 8 fields */ }
  export interface ItemBoxView { boxIdx: number; position: Vec3; respawnTicks: number }
  export interface RaceView { /* 13 fields */ }
  export function createRaceView(itemBoxCount: number): RaceView
  export function viewSourceViolations(view: RaceView, role: ViewRole): string[]
  ```
- Produces — the 8 test-only fixture exports (contract §9.1), which every later
  `render` task imports from `packages/render/test/fixtures/render-fixtures`:
  ```ts
  export function makeRenderContext(): SimContext
  export function makeKartView(overrides?: Partial<KartView>): KartView
  export function makeRaceView(overrides?: Partial<RaceView>): RaceView
  export function makeThemeFixture(): TrackTheme
  export function makeCharacterDescriptorFixture(): CharacterDescriptor
  export function makeKartDescriptorFixture(): KartDescriptor
  export function loadShippedTrack(id: string): Track
  export const SHIPPED_TRACK_IDS: readonly string[]
  ```

---

- [ ] **Step 1: Write the failing test**

Two test files. `types.test.ts` proves the two functions; `fixtures.test.ts` proves the
fixture surface — in particular that `SHIPPED_TRACK_IDS` really is the six files on
disk, because **every later mesh test is an `it.each` over that array and an empty
array makes a whole suite pass by running nothing** (this project's signature defect).

Create `packages/render/test/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { createRaceView, viewSourceViolations } from '../src/types'
import type { RaceView, ViewSource } from '../src/types'

/** A view whose every seat and slot is filled the way the given role must fill it. */
function legalView(role: 'host' | 'guest' | 'solo', localPlayerId: number): RaceView {
  const v = createRaceView(4)
  v.localPlayerId = localPlayerId
  for (let i = 0; i < 8; i++) {
    v.karts[i].source =
      role === 'guest' ? (i === localPlayerId ? 'predicted' : 'interpolated') : 'authoritative'
  }
  v.entityCount = 2
  for (let j = 0; j < 32; j++) {
    if (j < v.entityCount) {
      v.entities[j].entityId = 100 + j
      v.entities[j].source = role === 'guest' ? 'interpolated' : 'authoritative'
    }
  }
  return v
}

describe('createRaceView', () => {
  it('allocates every array at its fixed length', () => {
    const v = createRaceView(16)
    expect(v.karts.length).toBe(8)
    expect(v.entities.length).toBe(32)
    expect(v.itemBoxes.length).toBe(16)
    expect(v.finishedOrder.length).toBe(8)
    expect(v.finishedOrder.every((x) => x === -1)).toBe(true)
    expect(v.finishTick).toBe(-1)
    expect(v.localPlayerId).toBe(-1)
  })

  it('indexes karts BY SEAT: karts[i].playerId === i', () => {
    const v = createRaceView(4)
    for (let i = 0; i < 8; i++) expect(v.karts[i].playerId).toBe(i)
  })

  it('numbers item boxes by index and starts every entity slot empty', () => {
    const v = createRaceView(3)
    for (let b = 0; b < 3; b++) expect(v.itemBoxes[b].boxIdx).toBe(b)
    for (let j = 0; j < 32; j++) {
      expect(v.entities[j].entityId).toBe(-1)
      expect(v.entities[j].source).toBe('absent')
    }
    expect(v.entityCount).toBe(0)
  })

  // The bug: `new Array(MAX_KARTS).fill(template)` or one shared ZERO Vec3. Every kart
  // then draws at whatever the last writer wrote — all eight stacked on one point — and
  // a length-only test passes happily. Mutating one and reading the others is the only
  // assertion that sees it.
  it('gives every Vec3 its own object', () => {
    const v = createRaceView(2)
    v.karts[0].position.x = 5
    v.karts[0].velocity.z = -3
    v.entities[0].position.y = 9
    v.itemBoxes[0].position.x = 7
    expect(v.karts[1].position.x).toBe(0)
    expect(v.karts[0].velocity.x).toBe(0)
    expect(v.karts[0].position.z).toBe(0)
    expect(v.karts[1].velocity.z).toBe(0)
    expect(v.entities[1].position.y).toBe(0)
    expect(v.itemBoxes[1].position.x).toBe(0)
  })

  // A fresh view is deliberately unfilled: 'absent' sources and place 0. If the default
  // were a plausible-looking 'authoritative' with place = i, a ViewBuilder that forgot to
  // write a seat would look correct in every downstream test.
  it('defaults to unfilled values, so a missing write is visible', () => {
    const v = createRaceView(1)
    expect(v.karts.every((k) => k.source === 'absent')).toBe(true)
    expect(v.karts.every((k) => k.place === 0)).toBe(true)
    expect(v.karts[0].driftTier).toBe(-1)
    expect(v.karts[0].item).toBe('none')
    expect(v.karts[0].surface).toBe('tarmac')
    expect(v.phase).toBe('countdown')
  })
})

describe('viewSourceViolations', () => {
  it('returns [] for a legal host, solo and guest view', () => {
    expect(viewSourceViolations(legalView('host', -1), 'host')).toEqual([])
    expect(viewSourceViolations(legalView('solo', -1), 'solo')).toEqual([])
    expect(viewSourceViolations(legalView('guest', 3), 'guest')).toEqual([])
  })

  // A checker that returns [] unconditionally passes every test above. This one it
  // cannot pass: a freshly allocated view is all-'absent', which is legal for nobody
  // as a KART source under host.
  it('reports all eight seats of an unfilled view under host', () => {
    const v = createRaceView(2)
    const errs = viewSourceViolations(v, 'host')
    expect(errs.length).toBe(8)
    expect(errs[0]).toBe(
      "kart[0]: source 'absent' is illegal for role 'host' (expected 'authoritative')",
    )
  })

  // THE central invariant (contract §7.1). A guest drawing a remote seat from state()
  // is drawing the sim's own bot AI for that seat — the karts visibly drive themselves
  // down a line no other player is on. This is the exact message that catches it.
  it("flags a guest drawing a REMOTE seat from prediction", () => {
    const v = legalView('guest', 3)
    v.karts[5].source = 'predicted'
    expect(viewSourceViolations(v, 'guest')).toEqual([
      "kart[5]: source 'predicted' is illegal for role 'guest' (expected 'interpolated' or 'absent')",
    ])
  })

  it("flags a guest drawing its OWN seat from the interpolator", () => {
    const v = legalView('guest', 3)
    v.karts[3].source = 'interpolated'
    expect(viewSourceViolations(v, 'guest')).toEqual([
      "kart[3]: source 'interpolated' is illegal for role 'guest' (expected 'predicted')",
    ])
  })

  it('allows an absent remote seat on a guest, and only there', () => {
    const guest = legalView('guest', 3)
    guest.karts[6].source = 'absent'
    expect(viewSourceViolations(guest, 'guest')).toEqual([])
    const host = legalView('host', -1)
    host.karts[6].source = 'absent'
    expect(viewSourceViolations(host, 'host')).toEqual([
      "kart[6]: source 'absent' is illegal for role 'host' (expected 'authoritative')",
    ])
  })

  it('reports an illegal guest localPlayerId and returns immediately', () => {
    const v = legalView('guest', 3)
    v.localPlayerId = -1
    // every seat is now wrong too, but no per-seat check is meaningful without a seat
    expect(viewSourceViolations(v, 'guest')).toEqual([
      "localPlayerId -1 is illegal for role 'guest'",
    ])
    v.localPlayerId = 8
    expect(viewSourceViolations(v, 'guest')).toEqual([
      "localPlayerId 8 is illegal for role 'guest'",
    ])
  })

  it('does not police localPlayerId on host or solo', () => {
    expect(viewSourceViolations(legalView('host', -1), 'host')).toEqual([])
    expect(viewSourceViolations(legalView('solo', -1), 'solo')).toEqual([])
  })

  it('flags a live entity slot with the wrong source', () => {
    const v = legalView('host', -1)
    v.entities[1].source = 'interpolated' as ViewSource
    expect(viewSourceViolations(v, 'host')).toEqual([
      "entity[1] (id 101): source 'interpolated' is illegal for role 'host' (expected 'authoritative')",
    ])
  })

  // Entities are removed by swap-remove, so a stale id left behind at a dead slot is the
  // realistic failure: the renderer draws a despawned shell forever. Both messages, in
  // this order.
  it('flags a dead slot that still carries an entityId, source message first', () => {
    const v = legalView('host', -1)
    v.entities[7].entityId = 42
    v.entities[7].source = 'authoritative'
    expect(viewSourceViolations(v, 'host')).toEqual([
      "entity[7] (id 42): source 'authoritative' is illegal for role 'host' (expected 'absent')",
      'entity[7]: entityId 42 is illegal at slot 7 with entityCount 2',
    ])
  })

  it('flags a live slot with no entityId', () => {
    const v = legalView('guest', 3)
    v.entities[0].entityId = -1
    expect(viewSourceViolations(v, 'guest')).toEqual([
      'entity[0]: entityId -1 is illegal at slot 0 with entityCount 2',
    ])
  })
})
```

Create `packages/render/test/fixtures.test.ts`:

```ts
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { validateTrack } from '@tapkart/sim'

import {
  SHIPPED_TRACK_IDS,
  loadShippedTrack,
  makeCharacterDescriptorFixture,
  makeKartDescriptorFixture,
  makeKartView,
  makeRaceView,
  makeRenderContext,
  makeThemeFixture,
} from './fixtures/render-fixtures'

// derived here independently of the fixture, so the two cannot drift together
const TRACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'content', 'tracks')

describe('render fixtures', () => {
  // Q34: the six shipped tracks are REQUIRED coverage, and every mesh test is an
  // `it.each(SHIPPED_TRACK_IDS)`. If this list were empty — or derived from a
  // directory read that silently found nothing — those suites would run zero cases
  // and report green. This is the assertion that stops that.
  it('SHIPPED_TRACK_IDS is exactly the six files in content/tracks, ascending', () => {
    const onDisk = readdirSync(TRACKS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort()
    expect(SHIPPED_TRACK_IDS.length).toBe(6)
    expect([...SHIPPED_TRACK_IDS]).toEqual(onDisk)
    expect([...SHIPPED_TRACK_IDS]).toEqual([
      'caldera',
      'dust-canyon',
      'glacier-pass',
      'harbor-run',
      'neon-district',
      'redwood-rise',
    ])
  })

  it.each([...SHIPPED_TRACK_IDS])('loadShippedTrack(%s) returns a valid, non-trivial Track', (id) => {
    const track = loadShippedTrack(id)
    expect(track.id).toBe(id)
    expect(validateTrack(track)).toEqual([])
    expect(track.controlPoints.length).toBeGreaterThanOrEqual(46)
    expect(track.startPositions.length).toBe(8)
    expect(track.checkpointS.length).toBeGreaterThanOrEqual(10)
  })

  it('loadShippedTrack throws on an unknown id rather than returning a husk', () => {
    expect(() => loadShippedTrack('no-such-track')).toThrow()
  })

  it('makeRenderContext gives a usable SimContext', () => {
    const ctx = makeRenderContext()
    expect(ctx.track.controlPoints.length).toBeGreaterThan(8)
    expect(ctx.characters.length).toBe(8)
    expect(ctx.query.totalLength()).toBeGreaterThan(100)
  })

  it('makeKartView applies overrides and still allocates fresh vectors', () => {
    const a = makeKartView({ playerId: 4, heading: 1.25 })
    const b = makeKartView()
    expect(a.playerId).toBe(4)
    expect(a.heading).toBe(1.25)
    a.position.x = 12
    expect(b.position.x).toBe(0)
  })

  it('makeRaceView is a filled, legal host view', () => {
    const v = makeRaceView()
    expect(v.karts.length).toBe(8)
    expect(v.karts.every((k) => k.source === 'authoritative')).toBe(true)
    expect(v.phase).toBe('racing')
    const w = makeRaceView({ phase: 'finished', tick: 99 })
    expect(w.phase).toBe('finished')
    expect(w.tick).toBe(99)
  })

  it('descriptor and theme fixtures sit inside their declared ranges', () => {
    const c = makeCharacterDescriptorFixture()
    expect(c.bodyHeight).toBeGreaterThanOrEqual(0.4)
    expect(c.bodyHeight).toBeLessThanOrEqual(1.4)
    expect(c.bodyRadius).toBeGreaterThanOrEqual(0.15)
    expect(c.bodyRadius).toBeLessThanOrEqual(0.5)
    expect(c.headRadius).toBeGreaterThanOrEqual(0.1)
    expect(c.headRadius).toBeLessThanOrEqual(0.4)
    const k = makeKartDescriptorFixture()
    expect(k.chassisLength).toBeGreaterThanOrEqual(1.4)
    expect(k.chassisLength).toBeLessThanOrEqual(2.6)
    expect(k.chassisWidth).toBeGreaterThanOrEqual(0.9)
    expect(k.chassisWidth).toBeLessThanOrEqual(1.6)
    expect(k.wheelRadius).toBeGreaterThanOrEqual(0.2)
    expect(k.wheelRadius).toBeLessThanOrEqual(0.45)
    const t = makeThemeFixture()
    const d = t.sunDirection
    expect(Math.abs(Math.hypot(d.x, d.y, d.z) - 1)).toBeLessThan(1e-6)
    expect(t.fog.near).toBeLessThan(t.fog.far)
    expect(t.edgeMarkers.spacing).toBeGreaterThanOrEqual(4)
    expect(t.edgeMarkers.spacing).toBeLessThanOrEqual(40)
    // the three road colours must differ, or the mesh tint test proves nothing
    expect(t.road).not.toEqual(t.roadDirt)
    expect(t.road).not.toEqual(t.shoulder)
    expect(t.roadDirt).not.toEqual(t.shoulder)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test`

Expected: FAIL. Both files fail to collect, with
`Error: Cannot find module '../src/types' imported from '/home/kasm-user/tapkart/packages/render/test/types.test.ts'`
(caused by `Failed to load url ../src/types ... Does the file exist?`) and
`Error: Cannot find module './fixtures/render-fixtures' imported from '/home/kasm-user/tapkart/packages/render/test/fixtures.test.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/render/package.json` — `three` is pinned **exactly**, no caret (Q10).
The `"./three"` export points at `src/three/renderer.ts`, which a later task creates;
npm does not resolve `exports` targets at install time and nothing imports that
subpath yet, so declaring it now is correct and inert.

```json
{
  "name": "@tapkart/render",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./three": "./src/three/renderer.ts"
  },
  "dependencies": {
    "@tapkart/sim": "*",
    "@tapkart/content": "*",
    "three": "0.180.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Create `packages/render/tsconfig.json` — R35: DOM is widened **here**, never in
`tsconfig.base.json`, which stays `"lib": ["ES2022"]` so `sim`, `protocol`, `net` and
`content` (the four packages `server` imports) can never acquire a DOM type:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/render/src/types.ts`:

```ts
// PURE (contract §0a): no DOM, no GPU, no clock, no `three` import — not even a
// type-only one (§8.2). These are the view structs `game` fills and `render` reads,
// and they are the entire game -> render handoff (§4.2). `render` never holds a
// SimState and imports nothing that can write one.
import type { EntityKind, ItemKind, RacePhase, Surface, Vec3 } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, v3 } from '@tapkart/sim'

/** The session's role, named once, in the lowest package that needs it. `game`
 *  imports this type rather than declaring a second union. There is no `SessionRole`. */
export type ViewRole = 'host' | 'guest' | 'solo'

/** Where a seat's transform came from. §7.1 is the full rule and
 *  `viewSourceViolations` is its executable form. */
export type ViewSource = 'authoritative' | 'predicted' | 'interpolated' | 'absent'

export interface KartView {
  playerId: number
  characterIdx: number // from the session, never from the wire
  source: ViewSource
  position: Vec3 // metres, world
  heading: number // radians, wrapped to (-pi, pi]
  velocity: Vec3 // m/s
  angularVelocity: number // rad/s
  speed: number // m/s, PLAN VIEW: hypot(velocity.x, velocity.z)
  s: number // arc-normalised [0, 1), NEVER metres
  bankAngle: number // radians, track banking under the kart
  driftActive: boolean
  driftDir: -1 | 0 | 1
  driftCharge: number // ticks
  driftTier: number // sim's encoding: -1 none, 0..2 index into driftBoosts
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  item: ItemKind
  lap: number // 0-based, exactly KartState.lap.lap
  checkpointIdx: number
  t: number
  place: number // 0-based; 0 = leader
  isBot: boolean
  connected: boolean
}

export interface EntityView {
  entityId: number // -1 in an unused slot
  kind: EntityKind
  ownerId: number
  source: ViewSource
  position: Vec3
  velocity: Vec3
  heading: number
  ttl: number // ticks
}

/** No `source` field, deliberately: item boxes have no authoritative wire form at
 *  all, so there is nothing for §7.1 to police. Availability is `respawnTicks === 0`
 *  and is never stored twice. */
export interface ItemBoxView {
  boxIdx: number
  position: Vec3 // from itemBoxWorldPos, verbatim
  respawnTicks: number
}

export interface RaceView {
  tick: number
  alpha: number // sub-tick fraction, [0, 1)
  phase: RacePhase
  localPlayerId: number // -1 for a spectator or a replay; never -1 for a guest
  raceStartTick: number
  karts: KartView[] // always length MAX_KARTS, indexed BY SEAT: karts[i].playerId === i
  entities: EntityView[] // always length MAX_ENTITIES, live packed at front
  entityCount: number
  itemBoxes: ItemBoxView[] // length = ctx.track.itemBoxes.length
  itemBoxRespawnTicks: number // ctx.tuning.itemBoxRespawnTicks
  finishedOrder: number[] // length MAX_KARTS, -1 in unfilled slots
  finishTick: number // -1 until the first kart finishes
  countdownTicksLeft: number // 0 once racing
}

/**
 * Allocates one fully-populated RaceView with every array at its fixed length and
 * every Vec3 distinct. Called once per session, never per frame.
 *
 * Defaults are deliberately *unfilled* rather than plausible: every source is
 * 'absent', every place is 0 and every driftTier is -1, so a ViewBuilder that forgets
 * to write a seat produces a view that `viewSourceViolations` rejects instead of one
 * that merely looks slightly wrong.
 */
export function createRaceView(itemBoxCount: number): RaceView {
  const karts: KartView[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    karts.push({
      playerId: i,
      characterIdx: 0,
      source: 'absent',
      position: v3(0, 0, 0),
      heading: 0,
      velocity: v3(0, 0, 0),
      angularVelocity: 0,
      speed: 0,
      s: 0,
      bankAngle: 0,
      driftActive: false,
      driftDir: 0,
      driftCharge: 0,
      driftTier: -1,
      airborne: false,
      surface: 'tarmac',
      spinOutTicks: 0,
      invulnTicks: 0,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
      item: 'none',
      lap: 0,
      checkpointIdx: 0,
      t: 0,
      place: 0,
      isBot: false,
      connected: false,
    })
  }
  const entities: EntityView[] = []
  for (let j = 0; j < MAX_ENTITIES; j++) {
    entities.push({
      entityId: -1,
      // `kind` is meaningless in an unused slot: `entityId === -1` is the liveness flag.
      kind: 'seeker',
      ownerId: -1,
      source: 'absent',
      position: v3(0, 0, 0),
      velocity: v3(0, 0, 0),
      heading: 0,
      ttl: 0,
    })
  }
  const itemBoxes: ItemBoxView[] = []
  for (let b = 0; b < itemBoxCount; b++) {
    itemBoxes.push({ boxIdx: b, position: v3(0, 0, 0), respawnTicks: 0 })
  }
  const finishedOrder: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) finishedOrder.push(-1)
  return {
    tick: 0,
    alpha: 0,
    phase: 'countdown',
    localPlayerId: -1,
    raceStartTick: 0,
    karts,
    entities,
    entityCount: 0,
    itemBoxes,
    itemBoxRespawnTicks: 0,
    finishedOrder,
    finishTick: -1,
    countdownTicksLeft: 0,
  }
}

/** `'a' or 'b'` — the exact `expected` rendering §7.1 specifies. */
function expectedList(sources: readonly ViewSource[]): string {
  return sources.map((s) => `'${s}'`).join(' or ')
}

/**
 * [] when the view obeys §7.1; otherwise one string per violating seat or slot, in the
 * exact format §7.1 specifies. Exported (not test-only) because the CI honesty test and
 * the dev-build assertion (Q32) must run the same code rather than two readings of one
 * table. Allocates; never called in the frame path of a production build.
 */
export function viewSourceViolations(view: RaceView, role: ViewRole): string[] {
  const out: string[] = []

  // 1. Local seat identity. No per-seat check is meaningful without a local seat.
  if (role === 'guest' && !(view.localPlayerId >= 0 && view.localPlayerId < MAX_KARTS)) {
    out.push(`localPlayerId ${view.localPlayerId} is illegal for role 'guest'`)
    return out
  }

  // 2. Karts, ascending seat index. A host's AuthorityLoop.state() IS the authority, so
  //    drawing every seat from it is legal; what is forbidden is a guest drawing another
  //    player's seat from its own prediction, which is the sim's bot AI driving that seat.
  for (let i = 0; i < MAX_KARTS; i++) {
    let allowed: ViewSource[]
    if (role === 'guest') {
      allowed = i === view.localPlayerId ? ['predicted'] : ['interpolated', 'absent']
    } else {
      allowed = ['authoritative']
    }
    const actual = view.karts[i].source
    if (!allowed.includes(actual)) {
      out.push(
        `kart[${i}]: source '${actual}' is illegal for role '${role}' ` +
          `(expected ${expectedList(allowed)})`,
      )
    }
  }

  // 3. Entities, ascending slot. Live slots are packed at the front.
  for (let j = 0; j < MAX_ENTITIES; j++) {
    const e = view.entities[j]
    const live = j < view.entityCount
    let allowed: ViewSource[]
    if (!live) allowed = ['absent']
    else allowed = role === 'guest' ? ['interpolated'] : ['authoritative']
    if (!allowed.includes(e.source)) {
      out.push(
        `entity[${j}] (id ${e.entityId}): source '${e.source}' is illegal for role '${role}' ` +
          `(expected ${expectedList(allowed)})`,
      )
    }
    if ((live && e.entityId < 0) || (!live && e.entityId >= 0)) {
      out.push(
        `entity[${j}]: entityId ${e.entityId} is illegal at slot ${j} ` +
          `with entityCount ${view.entityCount}`,
      )
    }
  }

  return out
}
```

Create `packages/render/src/index.ts` — the barrel. It deliberately does **not**
re-export `src/three/renderer.ts` (§8.2): a barrel that pulled it in would drag `three`,
and transitively a WebGL context, into every headless test in the repository, and the
failure would surface as an unrelated suite breaking. Later tasks append one line each,
in §4.11's order.

```ts
// Public barrel for @tapkart/render.
//
// packages/render/package.json maps "." to this file, so this list IS the package's
// public surface. It does NOT re-export `three/renderer` (contract §8.2), there is no
// `time` module (§4.1) and there is no `theme` module (§4.5) — TrackTheme is content.
//
// Contract §4.11's order, one line per module as each lands:
// types, mesh, descriptors, camera, frame, hud, audio, smoothing, backend.
export * from './types'
```

Create `packages/render/test/fixtures/render-fixtures.ts`:

```ts
// TEST-ONLY (contract §9.1). `src` never imports this file and never reads the
// filesystem: Q12 gives `src` its tracks through @tapkart/content's static imports.
// Tests read the REAL shipped tracks off disk (Q34), which is what makes every mesh
// assertion evidence about shipped content rather than about a synthetic oval.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SimContext, Track } from '@tapkart/sim'
import { validateTrack } from '@tapkart/sim'
import type { CharacterDescriptor, KartDescriptor, TrackTheme } from '@tapkart/content'

// §2.6: sim's fixtures live outside @tapkart/sim's `exports` map, so tests reach them
// by relative path and `src` never does.
import { makeContext, makeOvalTrack } from '../../../sim/test/fixtures/track-fixtures'
import type { KartView, RaceView } from '../../src/types'
import { createRaceView } from '../../src/types'

/** <repo>/content/tracks, four levels up from packages/render/test/fixtures. */
const TRACKS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'content',
  'tracks',
)

/**
 * The six shipped tracks (spec §1) in `id`-ascending order. Hand-written on purpose:
 * every mesh suite is an `it.each(SHIPPED_TRACK_IDS)`, and a list derived from a
 * directory read would silently become empty — turning a whole suite green by running
 * nothing. `fixtures.test.ts` asserts this equals the directory contents instead.
 */
export const SHIPPED_TRACK_IDS: readonly string[] = [
  'caldera',
  'dust-canyon',
  'glacier-pass',
  'harbor-run',
  'neon-district',
  'redwood-rise',
]

/** Loads a real shipped track off disk with node:fs. Test-only; src never does.
 *  Throws on an unreadable file or a failing `validateTrack`, so no test ever
 *  measures a mesh built from a half-valid track. */
export function loadShippedTrack(id: string): Track {
  const raw = readFileSync(join(TRACKS_DIR, `${id}.json`), 'utf8')
  const track = JSON.parse(raw) as Track
  const errs = validateTrack(track)
  if (errs.length > 0) throw new Error(`${id}.json is not a valid Track: ${errs.join('; ')}`)
  return track
}

/** A SimContext over sim's oval fixture: base tuning, the eight fixture characters,
 *  and a freshly built TrackQuery.
 *
 *  This deliberately uses sim's `makeContext`, NOT @tapkart/content's shipped constants:
 *  `CHARACTERS` is `readonly CharacterStats[]` and does not assign to
 *  `SimContext.characters: CharacterStats[]` under `strict` — a composition root has to
 *  write `CHARACTERS.slice()`, and a test fixture has no reason to pay that. `TUNING:
 *  Readonly<Tuning>` assigns fine; the array is the case that bites. */
export function makeRenderContext(): SimContext {
  return makeContext(makeOvalTrack())
}

export function makeKartView(overrides?: Partial<KartView>): KartView {
  const base: KartView = {
    playerId: 0,
    characterIdx: 0,
    source: 'authoritative',
    position: { x: 0, y: 0, z: 0 },
    heading: 0,
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: 0,
    speed: 0,
    s: 0,
    bankAngle: 0,
    driftActive: false,
    driftDir: 0,
    driftCharge: 0,
    driftTier: -1,
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
    item: 'none',
    lap: 0,
    checkpointIdx: 0,
    t: 0,
    place: 0,
    isBot: false,
    connected: true,
  }
  return { ...base, ...overrides }
}

/** A filled, legal HOST view: eight authoritative seats, racing, six item boxes
 *  (sim's oval fixture has six). */
export function makeRaceView(overrides?: Partial<RaceView>): RaceView {
  const view = createRaceView(6)
  view.phase = 'racing'
  view.localPlayerId = 0
  for (let i = 0; i < view.karts.length; i++) {
    view.karts[i].source = 'authoritative'
    view.karts[i].characterIdx = i
    view.karts[i].place = i
    view.karts[i].connected = true
  }
  view.itemBoxRespawnTicks = 180
  return Object.assign(view, overrides)
}

/** A theme whose road, roadDirt and shoulder colours are all different, so a mesh
 *  tint assertion can tell them apart. `sunDirection` is exactly unit length. */
export function makeThemeFixture(): TrackTheme {
  return {
    trackId: 'oval',
    road: [0.18, 0.18, 0.2],
    roadDirt: [0.35, 0.26, 0.18],
    shoulder: [0.24, 0.34, 0.16],
    wall: [0.4, 0.4, 0.45],
    ground: [0.2, 0.3, 0.15],
    sky: { top: [0.2, 0.4, 0.8], bottom: [0.7, 0.8, 0.9] },
    fog: { color: [0.7, 0.75, 0.8], near: 60, far: 600 },
    sunDirection: { x: 0.6, y: 0.8, z: 0 }, // |v| === 1 exactly
    ambient: 0.35,
    edgeMarkers: {
      spacing: 12,
      height: 1,
      offset: 1.5,
      colors: [
        [0.95, 0.95, 0.95],
        [0.85, 0.1, 0.1],
      ],
    },
  }
}

export function makeCharacterDescriptorFixture(): CharacterDescriptor {
  return {
    id: 'test-racer',
    name: 'Test Racer',
    bodyHeight: 1,
    bodyRadius: 0.3,
    headRadius: 0.22,
    palette: {
      primary: [0.9, 0.2, 0.2],
      secondary: [0.95, 0.8, 0.6],
      accent: [0.1, 0.1, 0.15],
    },
    silhouette: 'compact',
  }
}

export function makeKartDescriptorFixture(): KartDescriptor {
  return {
    id: 'test-kart',
    name: 'Test Kart',
    chassisLength: 1.8,
    chassisWidth: 1.2,
    chassisHeight: 0.5,
    wheelRadius: 0.3,
    wheelWidth: 0.2,
    palette: {
      body: [0.2, 0.4, 0.9],
      trim: [0.95, 0.95, 0.2],
      wheel: [0.08, 0.08, 0.09],
    },
  }
}
```

Install the new workspace member and its one runtime dependency, from the repo root:

```bash
npm install
```

`three@0.180.0` is the repository's second runtime dependency and is pinned exactly.
**Nothing in this task's tests imports it** — the only `three` import in the repository
arrives with `src/three/renderer.ts` in a later task — so if the registry is
unreachable, declare the dependency, note it in the task report, and continue: the
suite is green either way. What `npm install` is actually needed for here is the
`node_modules/@tapkart/render` workspace symlink that later packages resolve.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test`
Expected: PASS — 27 tests (15 in `types.test.ts`, 12 in `fixtures.test.ts`, six of which
are the `it.each` over the shipped tracks).

Then, both of these must be clean:

```bash
npm run typecheck --workspace @tapkart/render
npx vitest run
```

The second is the whole repository: this task adds a package to a suite that was green
before, and a `lib`-widening mistake in `tsconfig.base.json` (rather than in this
package's own tsconfig) shows up as `sim` suddenly compiling against DOM types.

- [ ] **Step 5: Commit**

```bash
git add packages/render/package.json packages/render/tsconfig.json \
        packages/render/src packages/render/test package.json package-lock.json && \
git commit -m "feat(render): scaffold @tapkart/render and the view structs

- three pinned at exactly 0.180.0 (Q10); DOM lib widened in this package only (R35)
- src/types.ts: KartView/EntityView/ItemBoxView/RaceView, createRaceView,
  viewSourceViolations in §7.1's exact message format
- test/fixtures/render-fixtures.ts: the §9.1 fixture surface, including
  loadShippedTrack reading the real content/tracks JSON with node:fs (Q34)"
```
