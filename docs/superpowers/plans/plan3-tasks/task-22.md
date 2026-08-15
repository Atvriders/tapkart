### Task 22: `src/shell.ts` and the `game` barrel

**Files:**
- Create: `packages/game/src/shell.ts` — **ADAPTER** (thin, untestable; §8.2). No test, by contract.
- Modify: `packages/game/src/index.ts` — the clock task created it carrying `export * from './clock'` and **no task has touched it since**: the controls, settings and app tasks each explicitly forbid themselves from touching it, and the session and view tasks are silent and touch nothing. This task brings it to §5.15's full list: keep the header comment, **replace** the single export line with the block in Step 3a. Do not try to merge into it — there is nothing to merge.
- Verify (do **not** create): `packages/game/src/vite-env.d.ts` — the view task created it. Its whole content is `/// <reference types="vite/client" />`. If it is missing, create it with that one line and say so in your report.
- Test: `packages/game/test/barrel.test.ts`

`packages/game/src/results.ts` and `packages/game/test/results.test.ts` are **not this
task's** — they were split out into their own task, placed immediately after the app task
so that the `app.ts` ↔ `results.ts` type-only cycle resolves in one step instead of
staying broken across three. This task now *consumes* `buildResultRows`.

**Interfaces:**

- Consumes, from `@tapkart/sim` (§2.1, §2.2):
  ```ts
  export const MAX_KARTS = 8
  export const RACE_LAPS = 3
  export interface Intent { tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }
  export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning; characters: CharacterStats[]; isLeader: boolean }
  ```
- Consumes, from `@tapkart/content` (§3a):
  ```ts
  export const TUNING: Readonly<Tuning>
  export const CHARACTERS: readonly CharacterStats[]
  export const TRACK_MANIFEST: readonly TrackManifestEntry[]      // { id, name }, id ascending
  export interface LoadedTrack { track: Track; query: TrackQuery; theme: TrackTheme }
  export function loadTrack(id: string): LoadedTrack               // synchronous, total, memoised
  export interface ContentBundle { characters: readonly CharacterDescriptor[]
                                   karts: readonly KartDescriptor[]
                                   themes: Readonly<Record<string, TrackTheme>> }
  export function loadContentBundle(): ContentBundle               // memoised
  ```
  **`CHARACTERS` is `readonly CharacterStats[]` and does NOT assign to
  `SimContext.characters: CharacterStats[]`.** Every composition root writes
  `characters: CHARACTERS.slice()`. (`TUNING: Readonly<Tuning>` *does* assign to
  `tuning: Tuning`, so the asymmetry is easy to miss — arrays are the case that
  bites. Found by the author of Tasks 1–3 while running their code; Task 2 pins
  it with a `createState`/`step` test.)
- Consumes, from `@tapkart/render` (§4.2, §4.6 – §4.10):
  ```ts
  export type ViewRole = 'host' | 'guest' | 'solo'
  export interface KartView { /* §4.2 */ characterIdx: number; lap: number; playerId: number }
  export interface RaceView { tick: number; alpha: number; phase: RacePhase; localPlayerId: number
    raceStartTick: number; karts: KartView[]; entities: EntityView[]; entityCount: number
    itemBoxes: ItemBoxView[]; itemBoxRespawnTicks: number; finishedOrder: number[]
    finishTick: number; countdownTicksLeft: number }
  export function createRaceView(itemBoxCount: number): RaceView
  export type CameraMode = 'chase' | 'countdown' | 'results' | 'free'
  export interface CameraState { position: Vec3; lookAt: Vec3; up: Vec3; fovDegrees: number; mode: CameraMode }
  export function createCameraState(): CameraState
  export const DEFAULT_CAMERA_PARAMS: Readonly<CameraParams>
  export function updateCamera(cam: CameraState, target: KartView, params: CameraParams,
                               mode: CameraMode, ticks: number): void
  export interface RenderFrame { /* §4.7 */ }
  export function createRenderFrame(itemBoxCount: number): RenderFrame
  export function buildRenderFrame(view: RaceView, cam: CameraState, theme: TrackTheme,
                                   characters: readonly CharacterDescriptor[],
                                   karts: readonly KartDescriptor[], out: RenderFrame): void
  export interface HudModel { visible: boolean; place: number /* 1-BASED */; fieldSize: number
    lap: number /* 1-BASED */; totalLaps: number; speedKph: number; item: ItemKind
    itemReady: boolean; driftTier: number; countdownLabel: CountdownLabel; raceClock: string
    respawning: boolean; spunOut: boolean; motionLocked: boolean; standings: HudStanding[] }
  export function createHudModel(): HudModel
  export function buildHudModel(view: RaceView, totalLaps: number, out: HudModel): void
  export interface AudioModel { engineFreqHz: number; engineGain: number; skidGain: number
                                cues: AudioCue[]; cueCount: number }
  export function createAudioModel(): AudioModel
  export function buildAudioModel(prev: RaceView, view: RaceView, out: AudioModel): void
  export interface AudioConfig { masterGain: number; enabled: boolean }
  export interface AudioBackend { apply(model: AudioModel): void; setConfig(cfg: AudioConfig): void; close(): void }
  export interface MeshData { positions: Float32Array; normals: Float32Array; uvs: Float32Array
                              colors: Float32Array; indices: Uint32Array }
  export const DEFAULT_MESH_OPTIONS: Readonly<MeshBuildOptions>
  export interface TrackScene { road: MeshData; boostPads: MeshData; ramps: MeshData
                                checkpoints: MarkerPlacement[]; edgeMarkers: EdgeMarkerPlacement[]
                                itemBoxes: Vec3[]       // index-paired with RenderFrame.itemBoxAlpha
                                bounds: { min: Vec3; max: Vec3 } }
  /** AMENDMENT 1: `ctx`, not `(track, query)`. `itemBoxWorldPos` — sim's, and the sole
   *  writer of an item box's world position — needs a SimContext, and SimContext carries
   *  both `track` and `query`, so the 3-arg form is strictly narrower: it is no longer
   *  possible to hand this function a query built for a different track. */
  export function buildTrackScene(ctx: SimContext, theme: TrackTheme,
                                  opts: MeshBuildOptions): TrackScene
  export function buildCharacterMesh(desc: CharacterDescriptor): MeshData
  export function buildKartMesh(desc: KartDescriptor): MeshData
  export interface RendererBackend {
    setScene(scene: TrackScene, theme: TrackTheme, kartMeshes: readonly MeshData[],
             characterMeshes: readonly MeshData[]): void
    applyFrame(frame: RenderFrame): void
    resize(widthPx: number, heightPx: number, devicePixelRatio: number): void
    stats(): RendererStats
    dispose(): void
  }
  ```
- Consumes, from `packages/game`'s earlier tasks:
  ```ts
  // ./clock (§5.1)
  export interface FrameClock { nowMs(): number }
  export function accumulatorAlpha(acc: TickAccumulator): number
  // @tapkart/net (AMENDMENT 4) — the whole accumulator moved out of game/clock.ts,
  // because packages/server runs the same fixed-step pump and net may not import
  // game. This file imports it from net directly, exactly as the server will.
  // SHIPPED SIGNATURES, which differ from contract §5.1 in three places: the type
  // has ONE field (no lastNowMs), the second argument is an elapsed DELTA rather
  // than an absolute nowMs, and the clamp is 5 rather than 8. THIS FILE is the
  // caller that therefore owns `lastNowMs` — one `let` and one subtraction.
  export interface TickAccumulator { residualMs: number }
  export function makeTickAccumulator(): TickAccumulator
  export function advanceAccumulator(acc: TickAccumulator, elapsedMs: number): number
  // ./results (the task immediately after the app task)
  export interface ResultRow { place: number; playerId: number; name: string; dnf: boolean }
  export function buildResultRows(view: RaceView, slots: readonly LobbySlot[]): ResultRow[]
  // ./settings (§5.7)
  export interface Settings { scheme: ControlScheme; tiltCalibration: TiltCalibration
    invertTilt: boolean; audioEnabled: boolean; audioVolume: number; characterIdx: number
    lastTrackId: string; playerName: string }
  export interface KeyValueStore { get(key: string): string | null; set(key: string, value: string): void }
  export function loadSettings(store: KeyValueStore): Settings
  export function saveSettings(store: KeyValueStore, s: Settings): void
  // ./controls/types (§5.5)
  export interface Viewport { width: number; height: number }
  export interface ControlInputs { pointers: PointerSample[]; pointerCount: number
    keys: Record<string, boolean>; tilt: TiltSample | null; viewport: Viewport }
  export function createControlInputs(): ControlInputs
  export interface ControlAdapter { readonly scheme: ControlScheme
    sample(raw: ControlInputs, tick: number, out: Intent): void; reset(): void }
  // ./controls/config (§5.5)
  export interface ControlConfig { deadZone: number; steerGain: number; steerSmoothingPerTick: number
    tiltNeutralDegrees: number; tiltRangeDegrees: number; tiltCalibration: TiltCalibration
    invertTilt: boolean; keyBindings: Record<string, 'left'|'right'|'accel'|'brake'|'drift'|'item'> }
  export const DEFAULT_CONTROL_CONFIG: Readonly<ControlConfig>
  // ./controls/index (§5.5)
  export function makeControlAdapter(scheme: ControlScheme, cfg: ControlConfig): ControlAdapter
  // ./controls/source (§5.6) — DOM adapter; ONLY shell.ts may import it
  export interface InputSource { drain(out: ControlInputs): void; detach(): void }
  export function attachInputSource(target: EventTarget, viewport: Viewport): InputSource
  export function requestTiltPermission(): Promise<boolean>
  // @tapkart/protocol — room codes RETIRE contract §5.8's game/src/roomcode.ts.
  // There is no such module: the alphabet's ORDER is the 5-bit wire index, so a
  // copy in `game` would be a second wire format. The code is 5 characters.
  export function normalizeRoomCode(raw: string): string
  export function isValidRoomCode(raw: string): boolean
  // ./app (§5.9)
  export type ScreenId = 'title' | 'characterSelect' | 'lobby' | 'race' | 'results'
  export interface LobbySlot { playerId: number; name: string; characterIdx: number
                               isBot: boolean; connected: boolean; ready: boolean }
  export interface AppState { screen: ScreenId; role: ViewRole; roomCode: string; trackId: string
    localPlayerId: number; slots: LobbySlot[]; settings: Settings; results: ResultRow[]
    error: string; connecting: boolean }
  export function createAppState(settings: Settings): AppState
  export type AppEvent =
    | { kind: 'hostPressed' }
    | { kind: 'joinPressed' }
    | { kind: 'soloPressed' }
    | { kind: 'roomCodeEntered'; code: string }
    | { kind: 'connected'; roomCode: string; localPlayerId: number }
    | { kind: 'connectFailed'; message: string }
    | { kind: 'lobbyUpdated'; slots: LobbySlot[] }
    | { kind: 'characterChosen'; characterIdx: number }
    | { kind: 'trackChosen'; trackId: string }
    | { kind: 'settingsChanged'; settings: Settings }
    | { kind: 'raceStarting' }
    | { kind: 'raceTick'; phase: RacePhase; finishedOrder: readonly number[] }
    | { kind: 'raceFinished'; results: ResultRow[] }
    | { kind: 'backToLobby' }
    | { kind: 'quitToTitle' }
  export function reduceApp(prev: AppState, ev: AppEvent): AppState
  export const SCREEN_TRANSITIONS: Readonly<Record<ScreenId, readonly AppEvent['kind'][]>>
  // ./session (Task 20), ./localinput (Task 20), ./view (Task 21)
  export function createSession(opts: SessionOptions): RaceSession
  export function createSoloTransport(): LocalInputTransport
  export function createViewBuilder(session: RaceSession): ViewBuilder
  ```

- Produces:
  ```ts
  // packages/game/src/shell.ts   — ADAPTER, never re-exported from the barrel
  export interface ShellOptions { canvas: HTMLCanvasElement; root: HTMLElement
    clock: FrameClock; store: KeyValueStore; renderer: RendererBackend; audio: AudioBackend }
  export interface GameShell { stop(): void }
  export function startShell(opts: ShellOptions): GameShell

  // packages/game/src/index.ts — re-exports only, no new symbols
  ```
  The barrel re-exports `./results`, which is another task's module now; the barrel
  test below is therefore an assertion about that task's output as much as this one's.
  The `apps/web` task imports `startShell` from `@tapkart/game/shell` — the second
  `exports` entry of the package (§10) — and nothing else from this file.

**What this task decides, and why**

- **The shell contains no game decisions** (§0a). Every branch it would want is a
  field on `RenderFrame`, `HudModel` or `AppState`, and the buttons it draws come
  from `SCREEN_TRANSITIONS` — the reducer's own table — so the two can never
  disagree about what is legal on a screen.
- **`swapViews()` is called AFTER `audio.apply`.** The two `RaceView`s are the
  session's (Task 20). `buildAudioModel` takes the delta between the previous
  frame's view and this one; cues are consumed in the frame they are raised, so
  swapping any earlier drops them and swapping never at all (one shared view)
  makes every delta empty and every one-shot cue unreachable. This ordering is
  the whole fix — do not tidy it upward.
- **Plan 3 has one transport source.** There is no server, no signalling and no
  WebRTC until Plan 4 (§12), so `hostPressed`/`joinPressed` are answered
  immediately with `connectFailed`, and the race screen always builds a solo
  transport. That is honest about what this build can do; a lobby that spins
  forever is not.

---

- [ ] **Step 1: Write the failing test**

Create `packages/game/test/barrel.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import * as barrel from '../src/index'
import * as app from '../src/app'
import * as clock from '../src/clock'
import * as composite from '../src/controls/composite'
import * as config from '../src/controls/config'
import * as controls from '../src/controls/index'
import * as controlTypes from '../src/controls/types'
import * as tilt from '../src/controls/tilt'
import * as localinput from '../src/localinput'
import * as results from '../src/results'
import * as session from '../src/session'
import * as settings from '../src/settings'
import * as view from '../src/view'

const MODULES: Array<[string, Record<string, unknown>]> = [
  ['clock', clock],
  ['controls/types', controlTypes],
  ['controls/config', config],
  ['controls/tilt', tilt],
  ['controls/composite', composite],
  ['controls/index', controls],
  ['settings', settings],
  ['app', app],
  ['results', results],
  ['session', session],
  ['localinput', localinput],
  ['view', view],
]

describe('@tapkart/game barrel', () => {
  it('re-exports every listed module with no name collisions', () => {
    const owner = new Map<string, string>()
    const clashes: string[] = []
    for (const [name, mod] of MODULES) {
      for (const key of Object.keys(mod)) {
        const prev = owner.get(key)
        if (prev !== undefined) clashes.push(`${key}: ${prev} and ${name}`)
        else owner.set(key, name)
      }
    }
    expect(clashes).toEqual([])
    for (const key of owner.keys()) expect(Object.keys(barrel)).toContain(key)
  })

  it('does NOT re-export either DOM adapter (§8.2)', () => {
    // A barrel that re-exported shell.ts or controls/source.ts would pull DOM
    // listeners — and, through the render barrel's sibling mistake, `three` and
    // a WebGL context — into every headless test in the repository. The failure
    // then shows up as an unrelated suite breaking.
    const keys = Object.keys(barrel)
    for (const forbidden of ['startShell', 'attachInputSource', 'requestTiltPermission']) {
      expect(keys).not.toContain(forbidden)
    }
    // …and not the sub-adapters either, which reach the outside world only
    // through makeControlAdapter.
    for (const forbidden of ['makeThumbZonesAdapter', 'makeVirtualStickAdapter', 'makeKeyboardAdapter']) {
      expect(keys).not.toContain(forbidden)
    }
    expect(keys).toContain('makeControlAdapter')
    expect(keys).toContain('createSession')
    expect(keys).toContain('createViewBuilder')
    expect(keys).toContain('buildResultRows')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/barrel.test.ts`

Expected: **FAIL on an assertion, not at collection** — `Tests 2 failed (2)`. Every one
of the twelve module imports resolves: `src/results.ts` was shipped by the task after
the app task, and `src/index.ts` has existed since the clock task created it carrying one
line. What is wrong is the barrel's *contents*, and the first `it` says so:

```
AssertionError: expected [ 'accumulatorAlpha', 'makeFixedClock', 'realFrameClock',
'renderNowMs' ] to contain 'createControlInputs'
```

— the barrel carries `./clock`'s six exports and nothing else. The second `it` then fails
at `expect(keys).toContain('makeControlAdapter')` for the same reason.

This is a **better** RED than a missing file: a `Failed to load url` proves only that
something is absent, while this proves the barrel exists, resolves, and is incomplete —
which is the actual defect this step is looking for. If instead you see
`Error: Failed to load url ../src/results`, the results task has not landed and this task
is running out of order; go back rather than creating `results.ts` here.

(Note what is **not** in that list. Amendment 4 moved the whole accumulator —
`TickAccumulator`, `makeTickAccumulator`, `advanceAccumulator`, `MAX_CATCHUP_TICKS` —
to `@tapkart/net`, and `game/clock.ts` re-exports none of it, so the game barrel never
carries net's symbols under a second name. `roomcode` is absent from the module list
for the same reason: room codes are `@tapkart/protocol`'s and `game/src/roomcode.ts`
does not exist.)

- [ ] **Step 3a: Bring `packages/game/src/index.ts` to its full list**

The file already exists (Task 16 created it). Its export lines become exactly
this — every module §5.15 names, in that order, and nothing else:

```ts
// The @tapkart/game barrel. It re-exports the PURE modules only.
//
// Not `./controls/source` and not `./shell` — both are DOM adapters (§8.2) —
// and not `./controls/thumbzones`, `./controls/stick` or `./controls/keyboard`,
// whose factories reach the outside world only through makeControlAdapter.
// `./controls/tilt` IS re-exported, because Settings names TiltCalibration and
// the screens call calibrateTilt; makeTiltAdapter rides along and is harmless.
//
// There is no `content/` directory in this package at all: R46 moved the tuning,
// the descriptors, the themes and the tracks to @tapkart/content, because
// Plan 4's shadow authority needs them and spec §3 forbids `server` from
// depending on `game`. There is no `./roomcode` either: §5.8 retired in favour of
// @tapkart/protocol, whose room-code alphabet ORDER is the 5-bit wire index.
export * from './clock'
export * from './controls/types'
export * from './controls/config'
export * from './controls/tilt'
export * from './controls/composite'
export * from './controls/index'
export * from './settings'
export * from './app'
export * from './results'
export * from './session'
export * from './localinput'
export * from './view'
```

- [ ] **Step 3b: Write `packages/game/src/shell.ts`**

```ts
// ADAPTER — thin, untestable, never imported by CI (§8.2). requestAnimationFrame,
// canvas sizing, DOM mounting and the orientation overlay live here and nowhere
// else in packages/game except controls/source.ts.
//
// It contains NO game decisions: every branch it would want is a field on
// RenderFrame, HudModel or AppState, and the buttons it draws come from
// SCREEN_TRANSITIONS — the reducer's own table — so the two cannot disagree.
import type { Intent, SimContext } from '@tapkart/sim'
import { MAX_KARTS, RACE_LAPS } from '@tapkart/sim'
import type { CharacterDescriptor, KartDescriptor, TrackTheme } from '@tapkart/content'
import { CHARACTERS, TRACK_MANIFEST, TUNING, loadContentBundle, loadTrack } from '@tapkart/content'
import type {
  AudioBackend,
  AudioModel,
  CameraMode,
  CameraState,
  HudModel,
  MeshData,
  RaceView,
  RenderFrame,
  RendererBackend,
} from '@tapkart/render'
import {
  DEFAULT_CAMERA_PARAMS,
  DEFAULT_MESH_OPTIONS,
  buildAudioModel,
  buildCharacterMesh,
  buildHudModel,
  buildKartMesh,
  buildRenderFrame,
  buildTrackScene,
  createAudioModel,
  createCameraState,
  createHudModel,
  createRenderFrame,
  updateCamera,
} from '@tapkart/render'
import type { AppEvent, AppState } from './app'
import { SCREEN_TRANSITIONS, createAppState, reduceApp } from './app'
// AMENDMENT 4: the accumulator is @tapkart/net's, because packages/server runs the
// same fixed-step pump and net may not import game. This file imports it from net
// exactly as the server will, and it takes an elapsed DELTA -- so this file, the
// only frame loop in the plan, is what owns `lastNowMs`. TICK_MS is NOT imported
// here and must never be: game/clock.ts is its only importer in the repository, and
// clock.test.ts scans every packages/*/src tree on every run to keep that true.
// Room codes come from @tapkart/protocol for the same one-copy reason.
import { advanceAccumulator, makeTickAccumulator } from '@tapkart/net'
import { isValidRoomCode, normalizeRoomCode } from '@tapkart/protocol'
import type { FrameClock } from './clock'
import { accumulatorAlpha } from './clock'
import type { ControlAdapter, ControlInputs, Viewport } from './controls/types'
import { createControlInputs } from './controls/types'
import type { ControlConfig } from './controls/config'
import { DEFAULT_CONTROL_CONFIG } from './controls/config'
import { makeControlAdapter } from './controls/index'
import { attachInputSource, requestTiltPermission } from './controls/source'
import { createSoloTransport } from './localinput'
import { buildResultRows } from './results'
import type { KeyValueStore, Settings } from './settings'
import { loadSettings, saveSettings } from './settings'
import type { RaceSession } from './session'
import { createSession } from './session'
import type { ViewBuilder } from './view'
import { createViewBuilder } from './view'

export interface ShellOptions {
  canvas: HTMLCanvasElement
  root: HTMLElement // where HUD/screen DOM is mounted
  clock: FrameClock
  store: KeyValueStore
  renderer: RendererBackend
  audio: AudioBackend // nullAudioBackend in v1 (Q26)
}

export interface GameShell {
  stop(): void
}

/** Plan 3 ships no server, no signalling and no WebRTC (§12), so this is the
 *  honest answer to Host and Join until Plan 4 lands. A lobby that spins forever
 *  is not. */
const MULTIPLAYER_MESSAGE = 'Multiplayer arrives in Plan 4 — press SOLO to race now.'

/** Events that carry a payload get a dedicated control, or are raised by the
 *  shell itself; the rest become one button each, straight off the reducer's
 *  own transition table. */
const PAYLOAD_EVENTS = new Set<AppEvent['kind']>([
  'roomCodeEntered', 'connected', 'connectFailed', 'lobbyUpdated',
  'characterChosen', 'trackChosen', 'settingsChanged', 'raceTick', 'raceFinished',
])

const BUTTON_LABELS: Readonly<Record<string, string | undefined>> = {
  hostPressed: 'HOST',
  joinPressed: 'JOIN',
  soloPressed: 'SOLO',
  raceStarting: 'START RACE',
  backToLobby: 'BACK TO LOBBY',
  quitToTitle: 'QUIT TO TITLE',
}

interface Race {
  session: RaceSession
  builder: ViewBuilder
  frame: RenderFrame
  cam: CameraState
  hud: HudModel
  audioModel: AudioModel
  theme: TrackTheme
  characters: readonly CharacterDescriptor[]
  karts: readonly KartDescriptor[]
  lastPhase: string
  lastFinishCount: number
  reportedFinish: boolean
}

function controlConfigFor(s: Settings): ControlConfig {
  return {
    ...DEFAULT_CONTROL_CONFIG,
    tiltCalibration: s.tiltCalibration,
    invertTilt: s.invertTilt,
  }
}

/** A stable seed from the room code, so every peer in a room simulates the same
 *  race. Plan 4's lobby `start` message carries the real one; until then a solo
 *  race is deterministic and reproducible, which is what this plan wants. */
function seedFor(roomCode: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < roomCode.length; i++) {
    h ^= roomCode.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function countFilled(order: readonly number[]): number {
  let n = 0
  for (let i = 0; i < order.length; i++) if (order[i] !== -1) n++
  return n
}

/** requestAnimationFrame loop, in this exact order:
 *    inputSource.drain -> advanceAccumulator -> N x (adapter.sample +
 *    session.tickOnce) -> updateCamera(N ticks) -> viewBuilder.build(alpha) ->
 *    buildRenderFrame -> renderer.applyFrame -> buildHudModel -> DOM ->
 *    buildAudioModel -> audio.apply -> session.swapViews.
 *
 *  Two things it does outside that loop: it calls audio.setConfig on every
 *  Settings change and once at startup (R38 — never per frame), and it shows the
 *  rotate-your-device overlay while viewport.height > viewport.width (R40),
 *  skipping renderer.resize until the device is landscape again. */
export function startShell(opts: ShellOptions): GameShell {
  const { canvas, root, clock, store, renderer, audio } = opts

  const screenEl = document.createElement('div')
  screenEl.className = 'tk-screen'
  const hudEl = document.createElement('div')
  hudEl.className = 'tk-hud'
  const rotateEl = document.createElement('div')
  rotateEl.className = 'tk-rotate'
  rotateEl.textContent = 'Rotate your device'
  root.append(screenEl, hudEl, rotateEl)

  let settings = loadSettings(store)
  let app: AppState = createAppState(settings)
  // R38: once at startup and on every Settings change, never per frame.
  audio.setConfig({ masterGain: settings.audioVolume, enabled: settings.audioEnabled })

  const viewport: Viewport = { width: window.innerWidth, height: window.innerHeight }
  const inputSource = attachInputSource(window, viewport)
  const rawInputs: ControlInputs = createControlInputs()
  const intent: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
  let adapter: ControlAdapter = makeControlAdapter(settings.scheme, controlConfigFor(settings))
  const acc = makeTickAccumulator()
  // The accumulator holds no timestamp (it has one field, `residualMs`), so the
  // caller owns the previous instant and hands `advanceAccumulator` a delta.
  let lastNowMs = clock.nowMs()

  let race: Race | null = null
  let lastW = -1
  let lastH = -1
  let lastDpr = -1
  let running = true
  let rafId = 0

  function startRace(st: AppState): Race {
    const loaded = loadTrack(st.trackId)
    const bundle = loadContentBundle()
    const ctx: SimContext = {
      track: loaded.track,
      query: loaded.query,
      tuning: TUNING,
      // CHARACTERS is `readonly CharacterStats[]` and SimContext.characters is
      // mutable. The copy is required by the type, not defensive.
      characters: CHARACTERS.slice(),
      isLeader: st.role !== 'guest',
    }
    const characterIdx: number[] = []
    for (let i = 0; i < MAX_KARTS; i++) characterIdx.push(st.slots[i].characterIdx)

    const session = createSession({
      role: st.role,
      ctx,
      localPlayerId: st.localPlayerId >= 0 ? st.localPlayerId : 0,
      seed: seedFor(st.roomCode),
      characterIdx,
      // Plan 3 has exactly one transport source. Plan 4 supplies the real one
      // and this is the only line that changes.
      transport: createSoloTransport(),
    })

    const kartMeshes: MeshData[] = bundle.karts.map(buildKartMesh)
    const characterMeshes: MeshData[] = bundle.characters.map(buildCharacterMesh)
    renderer.setScene(
      // AMENDMENT 1: three arguments, and `ctx` is the one built eight lines above.
      // `buildTrackScene` needs a SimContext because `itemBoxWorldPos` does, and
      // that is what makes the drawn item box and the pickup volume one object.
      buildTrackScene(ctx, loaded.theme, DEFAULT_MESH_OPTIONS),
      loaded.theme,
      kartMeshes,
      characterMeshes,
    )

    return {
      session,
      // createViewBuilder primes BOTH of the session's views, so the first
      // frame's audio delta is empty instead of "a real view minus a zeroed one".
      builder: createViewBuilder(session),
      frame: createRenderFrame(loaded.track.itemBoxes.length),
      cam: createCameraState(),
      hud: createHudModel(),
      audioModel: createAudioModel(),
      theme: loaded.theme,
      characters: bundle.characters,
      karts: bundle.karts,
      lastPhase: '',
      lastFinishCount: -1,
      reportedFinish: false,
    }
  }

  function endRace(): void {
    if (race === null) return
    race.session.close()
    race = null
    hudEl.replaceChildren()
  }

  function dispatch(ev: AppEvent): void {
    const next = reduceApp(app, ev)
    if (next === app) return // an illegal event is an identity no-op, by reference
    const prevScreen = app.screen
    app = next

    if (next.settings !== settings) {
      settings = next.settings
      saveSettings(store, settings)
      audio.setConfig({ masterGain: settings.audioVolume, enabled: settings.audioEnabled })
      adapter = makeControlAdapter(settings.scheme, controlConfigFor(settings))
      adapter.reset()
    }
    if (next.screen !== prevScreen) {
      if (next.screen === 'race') race = startRace(next)
      else endRace()
    }
    renderScreen()
  }

  // --- screen DOM ---------------------------------------------------------
  function button(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'tk-btn'
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  function selectScheme(scheme: Settings['scheme']): void {
    if (scheme !== 'tilt') {
      dispatch({ kind: 'settingsChanged', settings: { ...settings, scheme } })
      return
    }
    // Q22: the permission is requested on the tap that SELECTS tilt, which is
    // the unambiguous user gesture iOS requires. On denial the selection reverts
    // and the reason is shown — silent fallback is forbidden.
    void requestTiltPermission().then((granted) => {
      if (granted) dispatch({ kind: 'settingsChanged', settings: { ...settings, scheme: 'tilt' } })
      else dispatch({ kind: 'connectFailed', message: 'Motion access was denied, so tilt steering is unavailable.' })
    })
  }

  function renderScreen(): void {
    screenEl.replaceChildren()
    if (app.screen === 'race') {
      screenEl.classList.add('tk-hidden')
      return
    }
    screenEl.classList.remove('tk-hidden')

    const title = document.createElement('h1')
    title.textContent = app.screen === 'results' ? 'RESULTS' : 'TAPKART'
    screenEl.append(title)

    if (app.error !== '') {
      const err = document.createElement('p')
      err.className = 'tk-error'
      err.textContent = app.error
      screenEl.append(err)
    }
    if (app.roomCode !== '') {
      const code = document.createElement('p')
      code.textContent = `ROOM ${app.roomCode}`
      screenEl.append(code)
    }

    const legal = SCREEN_TRANSITIONS[app.screen]

    if (legal.includes('characterChosen')) {
      const row = document.createElement('div')
      row.className = 'tk-row'
      const descriptors = loadContentBundle().characters
      for (let i = 0; i < descriptors.length; i++) {
        const idx = i
        row.append(button(descriptors[idx].name, () => dispatch({ kind: 'characterChosen', characterIdx: idx })))
      }
      screenEl.append(row)
    }

    if (legal.includes('trackChosen')) {
      const sel = document.createElement('select')
      for (const entry of TRACK_MANIFEST) {
        const o = document.createElement('option')
        o.value = entry.id
        o.textContent = entry.name
        if (entry.id === app.trackId) o.selected = true
        sel.append(o)
      }
      sel.addEventListener('change', () => dispatch({ kind: 'trackChosen', trackId: sel.value }))
      screenEl.append(sel)
    }

    if (legal.includes('roomCodeEntered')) {
      const input = document.createElement('input')
      input.placeholder = 'ROOM CODE'
      input.maxLength = 8
      const go = button('GO', () => {
        const code = normalizeRoomCode(input.value)
        if (isValidRoomCode(code)) dispatch({ kind: 'roomCodeEntered', code })
      })
      screenEl.append(input, go)
    }

    if (legal.includes('settingsChanged')) {
      const row = document.createElement('div')
      row.className = 'tk-row'
      for (const scheme of ['thumbZones', 'tilt', 'virtualStick'] as const) {
        const b = button(scheme, () => selectScheme(scheme))
        if (settings.scheme === scheme) b.classList.add('tk-on')
        row.append(b)
      }
      row.append(
        button(settings.audioEnabled ? 'AUDIO ON' : 'AUDIO OFF', () =>
          dispatch({ kind: 'settingsChanged', settings: { ...settings, audioEnabled: !settings.audioEnabled } }),
        ),
      )
      screenEl.append(row)
    }

    if (app.screen === 'results') {
      const list = document.createElement('ol')
      for (const r of app.results) {
        const li = document.createElement('li')
        li.textContent = `${r.place}. ${r.name}${r.dnf ? ' — DNF' : ''}`
        list.append(li)
      }
      screenEl.append(list)
    }

    const actions = document.createElement('div')
    actions.className = 'tk-row'
    for (const kind of legal) {
      if (PAYLOAD_EVENTS.has(kind)) continue
      const label = BUTTON_LABELS[kind] ?? kind
      actions.append(
        button(label, () => {
          dispatch({ kind } as AppEvent)
          if (kind === 'hostPressed' || kind === 'joinPressed') {
            dispatch({ kind: 'connectFailed', message: MULTIPLAYER_MESSAGE })
          }
        }),
      )
    }
    screenEl.append(actions)
  }

  // --- HUD DOM ------------------------------------------------------------
  const hudPlace = document.createElement('div')
  const hudLap = document.createElement('div')
  const hudSpeed = document.createElement('div')
  const hudClock = document.createElement('div')
  const hudItem = document.createElement('div')
  const hudCountdown = document.createElement('div')
  hudCountdown.className = 'tk-countdown'

  function paintHud(hud: HudModel): void {
    if (hudEl.childElementCount === 0) {
      hudEl.append(hudPlace, hudLap, hudSpeed, hudClock, hudItem, hudCountdown)
    }
    hudEl.classList.toggle('tk-hidden', !hud.visible)
    hudPlace.textContent = `${hud.place}/${hud.fieldSize}`
    hudLap.textContent = `LAP ${hud.lap}/${hud.totalLaps}`
    hudSpeed.textContent = `${hud.speedKph} KM/H`
    hudClock.textContent = hud.raceClock
    hudItem.textContent = hud.itemReady ? hud.item.toUpperCase() : ''
    hudCountdown.textContent = hud.countdownLabel
  }

  function cameraModeFor(view: RaceView): CameraMode {
    if (view.phase === 'countdown') return 'countdown'
    if (view.phase === 'finished') return 'results'
    return 'chase'
  }

  // --- the frame ----------------------------------------------------------
  function frame(): void {
    if (!running) return
    rafId = requestAnimationFrame(frame)

    viewport.width = canvas.clientWidth > 0 ? canvas.clientWidth : window.innerWidth
    viewport.height = canvas.clientHeight > 0 ? canvas.clientHeight : window.innerHeight
    // R40: landscape only. Q24's layout — 88 px buttons on fixed insets, left
    // half steering — has no portrait meaning, so portrait is not a state to lay
    // out for. The canvas is not resized until the device is landscape again.
    const portrait = viewport.height > viewport.width
    rotateEl.classList.toggle('tk-hidden', !portrait)
    if (!portrait) {
      const dpr = window.devicePixelRatio
      if (viewport.width !== lastW || viewport.height !== lastH || dpr !== lastDpr) {
        lastW = viewport.width
        lastH = viewport.height
        lastDpr = dpr
        renderer.resize(viewport.width, viewport.height, dpr)
      }
    }

    inputSource.drain(rawInputs)
    const nowMs = clock.nowMs()
    const ticks = advanceAccumulator(acc, nowMs - lastNowMs)
    lastNowMs = nowMs
    const r = race
    if (r === null) return

    for (let i = 0; i < ticks; i++) {
      adapter.sample(rawInputs, r.session.state().tick + 1, intent)
      r.session.tickOnce(intent)
    }

    const alpha = accumulatorAlpha(acc)
    // The camera is advanced BEFORE the view is rebuilt, against the newest view
    // there is — the one the previous frame wrote, which is prevView() until
    // this frame swaps. Smoothing is per TICK, so `ticks` is what it takes.
    const newest = r.session.prevView()
    const localId = newest.localPlayerId >= 0 ? newest.localPlayerId : 0
    updateCamera(r.cam, newest.karts[localId], DEFAULT_CAMERA_PARAMS, cameraModeFor(newest), ticks)

    const view = r.session.currentView()
    r.builder.build(alpha, view)
    buildRenderFrame(view, r.cam, r.theme, r.characters, r.karts, r.frame)
    renderer.applyFrame(r.frame)
    buildHudModel(view, RACE_LAPS, r.hud)
    paintHud(r.hud)
    buildAudioModel(r.session.prevView(), view, r.audioModel)
    audio.apply(r.audioModel)
    // AFTER audio.apply, never before: the cues raised by this frame's delta are
    // consumed above, and swapping any earlier drops them. Not swapping at all
    // (one shared view) makes every delta empty and no one-shot cue can fire.
    r.session.swapViews()

    const finishCount = countFilled(view.finishedOrder)
    if (view.phase !== r.lastPhase || finishCount !== r.lastFinishCount) {
      r.lastPhase = view.phase
      r.lastFinishCount = finishCount
      dispatch({ kind: 'raceTick', phase: view.phase, finishedOrder: view.finishedOrder })
    }
    if (view.phase === 'finished' && !r.reportedFinish) {
      r.reportedFinish = true
      dispatch({ kind: 'raceFinished', results: buildResultRows(view, app.slots) })
    }
  }

  renderScreen()
  rafId = requestAnimationFrame(frame)

  return {
    stop(): void {
      running = false
      cancelAnimationFrame(rafId)
      inputSource.detach()
      endRace()
      renderer.dispose()
      audio.close()
      screenEl.remove()
      hudEl.remove()
      rotateEl.remove()
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/barrel.test.ts`
Expected: **2 passing**.

Then run the whole game suite and the typecheck, which is the only verification
`shell.ts` gets in CI:

```bash
npx vitest run packages/game
npx tsc --noEmit -p packages/game/tsconfig.json
```

Expected: the game suite passes and `tsc` prints nothing — **including the app
module's `TS2307`**, which the results task cleared several tasks ago. If it is back,
`src/results.ts` was deleted or never landed.

`shell.ts` is an adapter (§8.2) and CI never imports it — the barrel test above is
what proves that stays true. It is exercised for real by the `apps/web` task, in a
browser, by a human.

**What each test catches, and whether it would actually fail under that bug:**

| Test | Bug | Fails? |
|---|---|---|
| barrel collisions | two modules exporting one name, which `export *` silently resolves to neither | yes |
| barrel completeness | a module missing from the barrel — the state this task starts in, with `./clock` alone | yes — every key of all twelve modules is asserted to reach `@tapkart/game` |
| barrel omits the adapters | re-exporting `shell` or `controls/source`, which drags DOM listeners into every headless test in the repository | yes |
| barrel omits the sub-adapters | re-exporting `makeThumbZonesAdapter` and friends, which reach the outside world only through `makeControlAdapter` | yes |

- [ ] **Step 5: Commit**

```bash
git add packages/game/src/shell.ts packages/game/src/index.ts \
        packages/game/test/barrel.test.ts && \
git commit -m "feat(game): the shell adapter and the package barrel"
```
