### Task 23: `apps/web` — the shell a human can open — and the golden `RenderFrame` fixture

**Files:**
- Verify (do **not** modify): root `package.json`, key `workspaces` — it must already contain `"apps/*"` (R36). **The repo-plumbing task owns this file and made that edit**, and its `scaffold.test.ts` is the standing regression guard for it; a second identical edit here stages nothing and reads as a mistake to whoever runs it. (No line range is cited: after that task's edit the array has moved, and a line number into a file an earlier task modified is a guess.)
- Verify (do **not** modify): root `vitest.config.ts`, key `test.include` — it must already contain `'apps/*/test/**/*.test.ts'` (R37). Same owner, same reason.
- Modify: `package-lock.json` — `npm install` side effect (Step 2), declared because five tasks in this plan rewrite it
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.ts`
- Create: `packages/render/test/fixtures/golden-frame.ts`
- Create: `packages/render/test/fixtures/golden-frame.txt` (generated in Step 5, never hand-written)
- Test: `packages/game/test/golden-frame.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/game` (the session, view and barrel tasks, via the barrel):
  ```ts
  export const realFrameClock: FrameClock
  export function createSession(opts: SessionOptions): RaceSession
  export function createSoloTransport(): LocalInputTransport
  export function createViewBuilder(session: RaceSession): ViewBuilder
  // AMENDMENT 3 — the golden test drives the double buffer itself, in the shell's
  // own order, so it names all three members rather than only createViewBuilder.
  export interface RaceSession {
    currentView(): RaceView
    prevView(): RaceView
    swapViews(): void
  }
  ```
- Consumes, from `@tapkart/game/shell` (Task 22 — the second `exports` entry, §10):
  ```ts
  export interface ShellOptions { canvas: HTMLCanvasElement; root: HTMLElement
    clock: FrameClock; store: KeyValueStore; renderer: RendererBackend; audio: AudioBackend }
  export interface GameShell { stop(): void }
  export function startShell(opts: ShellOptions): GameShell
  ```
- Consumes, from `@tapkart/render`:
  ```ts
  export const nullAudioBackend: AudioBackend
  export interface RenderFrame { camera: CameraState; karts: KartDraw[]; entities: EntityDraw[]
    entityCount: number; itemBoxAlpha: Float32Array; screenFlash: number
    screenTintColor: PaletteRGB; screenTintAmount: number; sourceTick: number }
  export interface KartDraw { playerId: number; characterIdx: number; visible: boolean
    position: Vec3; heading: number; roll: number; wheelSpin: number; steerAngle: number
    bodyTint: PaletteRGB; alpha: number; driftSparkTier: number; boostFlame: number
    shieldVisible: boolean }
  export interface EntityDraw { entityId: number; kind: EntityKind; visible: boolean
    position: Vec3; heading: number; scale: number; tint: PaletteRGB; alpha: number }
  export interface CameraState { position: Vec3; lookAt: Vec3; up: Vec3; fovDegrees: number; mode: CameraMode }
  export interface HudModel { visible: boolean; place: number; fieldSize: number; lap: number
    totalLaps: number; speedKph: number; item: ItemKind; itemReady: boolean; driftTier: number
    countdownLabel: CountdownLabel; raceClock: string; respawning: boolean; spunOut: boolean
    motionLocked: boolean; standings: HudStanding[] }
  export function createRenderFrame(itemBoxCount: number): RenderFrame
  export function buildRenderFrame(view: RaceView, cam: CameraState, theme: TrackTheme,
                                   characters: readonly CharacterDescriptor[],
                                   karts: readonly KartDescriptor[], out: RenderFrame): void
  export function createCameraState(): CameraState
  export function updateCamera(cam: CameraState, target: KartView, params: CameraParams,
                               mode: CameraMode, ticks: number): void
  export const DEFAULT_CAMERA_PARAMS: Readonly<CameraParams>
  export function createHudModel(): HudModel
  export function buildHudModel(view: RaceView, totalLaps: number, out: HudModel): void
  ```
- Consumes, from `@tapkart/render/three` (the adapter's own entry point, §10):
  ```ts
  export interface ThreeRendererOptions { antialias: boolean; maxPixelRatio: number; shadows: boolean }
  export const DEFAULT_THREE_OPTIONS: Readonly<ThreeRendererOptions>
  export function createThreeRenderer(canvas: HTMLCanvasElement, opts: ThreeRendererOptions): RendererBackend
  ```
- Consumes, from `@tapkart/content`: `TUNING`, `CHARACTERS`, `loadTrack`, `loadContentBundle`.
  **`CHARACTERS` is `readonly CharacterStats[]` and does not assign to
  `SimContext.characters: CharacterStats[]` — write `CHARACTERS.slice()`.**
- Consumes, from `@tapkart/sim`: `COUNTDOWN_TICKS`, `RACE_LAPS`, `resetBotHold`,
  `spawnEntity(state, kind, ownerId, position, heading, targetId, ttl, events): number`.

- Produces:
  ```ts
  // packages/render/test/fixtures/golden-frame.ts   (test-only; not a package export)
  export function serializeDerivedFrame(frame: RenderFrame, hud: HudModel): string
  export const GOLDEN_FRAME_FILE = 'packages/render/test/fixtures/golden-frame.txt'
  ```
  `apps/web` exports nothing: `src/main.ts` is an entry module, not a library.

**Two things this task decides, and why**

- **Q11: `apps/web` is Plan 3's, but only the thin shell.** A plan that ships
  three libraries and an exported `startShell` nobody calls has not produced
  working, testable software, which is the bar the plan structure exists to meet.
  Plan 3 must end with something a human can open in a browser and play.
  **Deferred to Plan 5:** PWA manifest, service worker, offline caching,
  Dockerfile, CI publish. Those are deploy concerns and travel with the deploy
  plan. Do not add them here.
- **The golden fixture covers only what is derived from simulation state**, and
  it lands last on purpose. Covered: kart transforms, entity transforms, camera
  pose, HUD numeric values, item-box alphas. **Not covered:** `bodyTint` and
  every palette, entity `tint` and `alpha`, `screenFlash`, `screenTintColor`,
  `screenTintAmount`, marker spacing, bloom, fog and every theme number. Placing
  it in the final task freezes the visual constants *after* they are tuned, which
  is the only ordering in which it is a net rather than a nuisance.

**Where the two golden files live, and why they are split**

The fixture is at the contract-pinned path, `packages/render/test/fixtures/`, and
imports nothing but `render`'s own types. The **test** lives in
`packages/game/test/`, because it drives a real `RaceSession` and `ViewBuilder`
and `packages/render` must not depend on `@tapkart/game` — that arrow is
backwards and §1 keeps it out on purpose. A game test reaching a render fixture
by relative path is the test-to-test cross-boundary reach §2.6 already permits.

---

- [ ] **Step 1: Create the workspace and the app (no meaningful failing test — verification is stated instead)**

A Vite config, an HTML file and a workspace manifest have no RED. Each has a
concrete check, given with its expected output.

**First, verify the two root files — do not edit them.** The repo-plumbing task
owns both and already made these edits; its `scaffold.test.ts` asserts them on
every run, and `apps/web` could not resolve `@tapkart/game` by bare specifier
without them, so if they were missing nothing in this plan would have compiled
since. Verify with:

```bash
node -e "const v=require('./package.json').workspaces; if (!Array.isArray(v) || !v.includes('apps/*')) throw new Error('workspaces is missing apps/*: ' + JSON.stringify(v)); console.log('WORKSPACES_OK')"
grep -c "apps/\*/test/\*\*/\*\.test\.ts" vitest.config.ts
```

Expect `WORKSPACES_OK` and `1`. If either check fails, **stop**: the first task of
this plan did not land, and the fix belongs there, not here. Do not add the entry
by hand — that task's test is what keeps it true, and a second writer of one file
is how the two drift.

`environment: 'node'`, `globals: false` and `reporters: ['default']` stay exactly
as they are (Q30). `apps/web` ships no test in Plan 3; the glob is already there
so Plan 5 does not have to touch the root config to add one.

Create `apps/web/package.json`:

```json
{
  "name": "@tapkart/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@tapkart/game": "*",
    "@tapkart/render": "*"
  },
  "devDependencies": {
    "vite": "^7.0.0"
  },
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Create `apps/web/tsconfig.json`:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"] },
  "include": ["src/**/*.ts", "vite.config.ts"]
}
```

Create `apps/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    // content/ lives at the repo root, OUTSIDE this Vite root, and
    // packages/content's static JSON imports reach it. Without this the dev
    // server refuses to serve them and every track fails to load.
    fs: { allow: ['../..'] },
  },
})
```

Create `apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
    />
    <title>Tapkart</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      html, body {
        margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
        background: #0b0d12; color: #e8ecf5;
        font: 500 16px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
        /* Without this the browser claims every touchmove for scrolling and
           steering stops working the moment a thumb moves. */
        touch-action: none;
        -webkit-user-select: none; user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      #tk-canvas { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
      #tk-root { position: fixed; inset: 0; pointer-events: none; }
      #tk-root > * { pointer-events: auto; }
      .tk-hidden { display: none !important; }
      .tk-screen {
        position: absolute; inset: 0; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 16px;
        background: rgba(11, 13, 18, 0.82); text-align: center; padding: 24px;
      }
      .tk-screen h1 { margin: 0; font-size: 40px; letter-spacing: 0.18em; }
      .tk-row { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
      .tk-btn {
        min-width: 120px; min-height: 56px; padding: 0 20px;
        border: 1px solid #47506a; border-radius: 12px;
        background: #171b25; color: inherit; font: inherit; letter-spacing: 0.08em;
      }
      .tk-btn.tk-on { background: #2b6cff; border-color: #2b6cff; }
      .tk-error { color: #ff8a8a; max-width: 32ch; }
      .tk-screen select, .tk-screen input {
        min-height: 48px; padding: 0 12px; border-radius: 10px;
        border: 1px solid #47506a; background: #171b25; color: inherit; font: inherit;
      }
      .tk-screen ol { text-align: left; font-size: 20px; line-height: 1.8; }
      .tk-hud {
        position: absolute; top: 16px; left: 16px; display: flex; flex-direction: column;
        gap: 4px; font-variant-numeric: tabular-nums; text-shadow: 0 2px 6px #000;
      }
      .tk-hud .tk-countdown {
        position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
        font-size: 22vmin; font-weight: 700; letter-spacing: 0.05em; pointer-events: none;
      }
      .tk-rotate {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        background: #0b0d12; font-size: 24px; letter-spacing: 0.1em;
      }
    </style>
  </head>
  <body>
    <canvas id="tk-canvas"></canvas>
    <div id="tk-root"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Create `apps/web/src/main.ts`:

```ts
// The entry module. It calls startShell and nothing else — every decision lives
// behind that call, in packages/game.
import { realFrameClock } from '@tapkart/game'
import { startShell } from '@tapkart/game/shell'
import { nullAudioBackend } from '@tapkart/render'
import { DEFAULT_THREE_OPTIONS, createThreeRenderer } from '@tapkart/render/three'

const canvas = document.getElementById('tk-canvas')
const root = document.getElementById('tk-root')
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('main: #tk-canvas is missing from index.html')
if (!(root instanceof HTMLElement)) throw new Error('main: #tk-root is missing from index.html')

// localStorage throws outright in some privacy modes, so both halves are
// guarded. Losing settings is a worse-but-playable game; a thrown exception here
// is a black screen.
const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      // Storage denied: the session still plays, it just does not persist.
    }
  },
}

const shell = startShell({
  canvas,
  root,
  clock: realFrameClock,
  store,
  renderer: createThreeRenderer(canvas, DEFAULT_THREE_OPTIONS),
  audio: nullAudioBackend, // Q26: the seam is authored, Web Audio is Plan 5's
})

// `pagehide` fires on mobile Safari where `beforeunload` does not.
window.addEventListener('pagehide', () => shell.stop())
```

- [ ] **Step 2: Verify the app — the exact commands and what the operator should see**

```bash
npm install
```
Expect: it completes without an error, and `apps/web` is now a workspace. Check
it resolved:
```bash
node -e "console.log(require('node:fs').realpathSync('node_modules/@tapkart/web'))"
```
Expect: a path ending in `/tapkart/apps/web`.

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```
Expect: **no output**. If it reports `Cannot find module '@tapkart/game/shell'`,
the `exports` map in `packages/game/package.json` is missing its second entry
(§10) — fix it there, not here.

```bash
npm run build -w @tapkart/web && ls apps/web/dist apps/web/dist/assets
```
Expect: `vite build` prints a bundle summary and `dist/index.html` plus
`dist/assets/*.js` exist.

```bash
npm run dev -w @tapkart/web
```
Expect: `VITE vX.Y.Z ready in … ms` and `➜  Local:   http://localhost:5173/`.
In a second shell:
```bash
curl -sf http://localhost:5173/ | grep -c 'tk-canvas'
```
Expect: `1`.

**Operator check, in a browser, in a landscape-shaped window** — this is Q11's
bar and the only thing that proves Plan 3 shipped a game:

1. `http://localhost:5173/` shows **TAPKART** with SOLO / HOST / JOIN buttons and
   the three control-scheme buttons, one highlighted.
2. Pressing **HOST** or **JOIN** shows *"Multiplayer arrives in Plan 4 — press
   SOLO to race now."* — Plan 3 ships no server (§12).
3. Pressing **SOLO** reaches character select; pressing **START RACE** shows a
   3D track with eight karts on the grid, a **3 → 2 → 1 → GO** countdown, and a
   HUD reading `1/8`, `LAP 1/3`, `0 KM/H`, `0:00.000`.
3a. **The track sits on a coloured ground plane, not on the sky.** Look at the
   horizon and off the edge of the ribbon: there must be a large flat surface in
   the theme's own ground colour underneath and around the road, visibly distinct
   from the sky above it, extending past the road on every side. A ribbon
   floating over a flat wash of sky colour means `setScene` never built the ground
   quad — §12 makes it half the visual budget, and **CI cannot see this** (§8.3),
   so this line is its only detector. While you are looking down: the boost pads
   and the ramps must be visibly different colours from the road, and the item
   boxes must be visible **as boxes** standing on the track, disappearing when
   collected and fading back in when they respawn.
4. After GO, the arrow keys steer and accelerate, KM/H rises, the chase camera
   follows, and the lap clock runs.
5. Narrowing the window until it is taller than it is wide shows **"Rotate your
   device"** and the canvas stops resizing until it is landscape again.

Report anything that does not happen. Nothing in this step is asserted by CI —
§8.3: CI proves the `RenderFrame` is right and that the adapter was handed it; it
cannot prove Three.js drew it.

- [ ] **Step 3: Write the failing golden test**

Create `packages/game/test/golden-frame.test.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent, SimContext } from '@tapkart/sim'
import { COUNTDOWN_TICKS, RACE_LAPS, resetBotHold, spawnEntity } from '@tapkart/sim'
import { CHARACTERS, TUNING, loadContentBundle, loadTrack } from '@tapkart/content'
import type { CameraMode, RaceView } from '@tapkart/render'
import {
  DEFAULT_CAMERA_PARAMS,
  buildHudModel,
  buildRenderFrame,
  createCameraState,
  createHudModel,
  createRenderFrame,
  updateCamera,
} from '@tapkart/render'
import { createSoloTransport } from '../src/localinput'
import { createSession } from '../src/session'
import { createViewBuilder } from '../src/view'
// §2.6: test-to-test relative reach. The fixture lives under packages/render
// because that is where the contract pins it; the test lives here because it
// drives a RaceSession, and `render` may not depend on `game`.
import { GOLDEN_FRAME_FILE, serializeDerivedFrame } from '../../render/test/fixtures/golden-frame'

const TRACK_ID = 'caldera'
const SEED = 0x7a9c31
const CHARACTER_IDX = [0, 1, 2, 3, 4, 5, 6, 7]
const TICKS = COUNTDOWN_TICKS + 120
const ALPHA = 0.375
const REGEN_CMD = 'UPDATE_GOLDEN=1 npx vitest run packages/game/test/golden-frame.test.ts'

/** A scripted, purely tick-derived intent: no clock, no randomness, and it
 *  drives, brakes, drifts and fires, so the frozen frame is a moving car rather
 *  than a kart sitting on the grid. */
function intentAt(tick: number): Intent {
  return {
    tick,
    steer: Math.sin(tick / 37) * 0.8,
    accel: 1,
    brake: tick % 97 === 0,
    drift: tick % 53 < 20,
    useItem: tick % 61 === 0,
  }
}

function cameraModeFor(view: RaceView): CameraMode {
  if (view.phase === 'countdown') return 'countdown'
  if (view.phase === 'finished') return 'results'
  return 'chase'
}

/** Drives the REAL per-frame path — session, ViewBuilder, camera, frame, HUD —
 *  exactly as the shell does, minus the DOM and the GPU. */
function renderGolden(): string {
  // The 30 Hz bot hold is module-scope in packages/sim/src/phase.ts. A golden
  // that did not clear it would depend on whatever ran in this process first.
  resetBotHold()

  const loaded = loadTrack(TRACK_ID)
  const bundle = loadContentBundle()
  const ctx: SimContext = {
    track: loaded.track,
    query: loaded.query,
    tuning: TUNING,
    characters: CHARACTERS.slice(), // readonly CharacterStats[] does not assign
    isLeader: true,
  }
  const session = createSession({
    role: 'solo',
    ctx,
    localPlayerId: 0,
    seed: SEED,
    characterIdx: CHARACTER_IDX.slice(),
    transport: createSoloTransport(),
  })

  // Two entities, planted deterministically, so the EntityDraw half of the
  // fixture covers something. A bot rolling an item is not a precondition a
  // regression net may depend on. The bubble also freezes §4.7's reconstruction
  // from the owner's drawn position, which is the subtlest rule in the frame
  // builder; it needs its owner shielded or updateEntities retires it.
  const st = session.state()
  const events: AuthEvent[] = []
  const slickOwner = st.karts[4]
  spawnEntity(st, 'slick', 4,
    { x: slickOwner.position.x + 3, y: slickOwner.position.y, z: slickOwner.position.z + 3 },
    0.5, -1, 900, events)
  st.karts[2].shielded = true
  const bubbleOwner = st.karts[2]
  spawnEntity(st, 'bubble', 2,
    { x: bubbleOwner.position.x, y: bubbleOwner.position.y, z: bubbleOwner.position.z },
    0, -1, 900, events)

  const builder = createViewBuilder(session)
  const frame = createRenderFrame(loaded.track.itemBoxes.length)
  const cam = createCameraState()
  const hud = createHudModel()

  for (let t = 1; t <= TICKS; t++) {
    session.tickOnce(intentAt(t))
    const newest = session.prevView()
    updateCamera(cam, newest.karts[0], DEFAULT_CAMERA_PARAMS, cameraModeFor(newest), 1)
    const view = session.currentView()
    builder.build(t === TICKS ? ALPHA : 0, view)
    buildRenderFrame(view, cam, loaded.theme, bundle.characters, bundle.karts, frame)
    buildHudModel(view, RACE_LAPS, hud)
    if (t === TICKS) {
      session.close()
      return serializeDerivedFrame(frame, hud)
    }
    session.swapViews()
  }
  /* c8 ignore next */
  throw new Error('unreachable: TICKS must be >= 1')
}

describe('the golden RenderFrame (Q33)', () => {
  const path = resolve(process.cwd(), GOLDEN_FRAME_FILE)

  it('is byte-identical to the recorded derived-geometry subset', () => {
    expect(existsSync(dirname(path))).toBe(true) // wrong cwd: run vitest from the repo root

    const actual = renderGolden()

    if (process.env.UPDATE_GOLDEN === '1') {
      // Refuse in CI for the same reason packages/sim/test/golden-regen.test.ts
      // does: a fixture that rewrites itself on the machine that checks it is
      // not evidence about anything.
      expect(process.env.CI).not.toBe('true')
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, actual, 'utf8')
      return
    }

    expect(existsSync(path), `no golden file — regenerate with: ${REGEN_CMD}`).toBe(true)
    const expected = readFileSync(path, 'utf8')
    const a = actual.split('\n')
    const e = expected.split('\n')
    // A raw toBe on a 60-line blob reports "strings differ" and nothing useful.
    for (let i = 0; i < Math.max(a.length, e.length); i++) {
      if (a[i] !== e[i]) {
        expect(`line ${i + 1}: ${a[i] ?? '<missing>'}`).toBe(`line ${i + 1}: ${e[i] ?? '<missing>'}`)
      }
    }
    expect(a.length).toBe(e.length)
  })

  it('is deterministic: two runs in one process agree exactly', () => {
    // If this fails and the case above passes, something in the frame path reads
    // a clock, a random number, or module-scope state that survives a race.
    expect(renderGolden()).toBe(renderGolden())
  })

  it('covers something: the frozen frame has a moving kart and a live entity', () => {
    // A golden over eight invisible karts and zero entities would be
    // byte-stable forever and would detect nothing at all — which is exactly how
    // a regression net becomes decoration.
    const lines = renderGolden().split('\n')
    const kart0 = lines.find((l) => l.startsWith('kart 0 ')) ?? ''
    const entities = lines.filter((l) => l.startsWith('entity ') && l.includes('visible=true'))
    expect(kart0).toContain('visible=true')
    expect(kart0).not.toContain('wheelSpin=0.000000')
    expect(entities.length).toBeGreaterThan(0)
    expect(lines.some((l) => l.startsWith('camera '))).toBe(true)
    expect(lines.some((l) => l.startsWith('hud '))).toBe(true)
    expect(lines.some((l) => l.startsWith('itembox 0 '))).toBe(true)
  })
})
```

- [ ] **Step 4: Run the golden test to verify it fails**

Run: `npx vitest run packages/game/test/golden-frame.test.ts`

Expected: FAIL at collection with
`Error: Failed to load url ../../render/test/fixtures/golden-frame (resolved id: .../packages/render/test/fixtures/golden-frame) ... Does the file exist?`
— the fixture module does not exist yet.

- [ ] **Step 5: Write the fixture, then generate the golden file**

Create `packages/render/test/fixtures/golden-frame.ts`:

```ts
// Test-only. It imports nothing but this package's own types, which is what lets
// the game-side test drive it without inverting the dependency arrow (§1).
import type { CameraState, EntityDraw, HudModel, KartDraw, RenderFrame, Vec3 } from '../../src/index'

/** The repository-root-relative path of the recorded fixture. Resolved against
 *  process.cwd(), which vitest sets to the repo root. */
export const GOLDEN_FRAME_FILE = 'packages/render/test/fixtures/golden-frame.txt'

/** Every number in a FIELD VALUE, so two implementations cannot disagree about
 *  precision. `(-0).toFixed(6)` is '0.000000', which is what keeps a signed zero
 *  from flaking the fixture. */
function n(v: number): string {
  return v.toFixed(6)
}

/** `x,y,z`, each component through n(). */
function v(p: Vec3): string {
  return `${n(p.x)},${n(p.y)},${n(p.z)}`
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
    const k: KartDraw = frame.karts[i]
    out.push(
      `kart ${i} playerId=${n(k.playerId)} visible=${k.visible} position=${v(k.position)}` +
        ` heading=${n(k.heading)} roll=${n(k.roll)} wheelSpin=${n(k.wheelSpin)}` +
        ` steerAngle=${n(k.steerAngle)} alpha=${n(k.alpha)}` +
        ` driftSparkTier=${n(k.driftSparkTier)} boostFlame=${n(k.boostFlame)}` +
        ` shieldVisible=${k.shieldVisible}`,
    )
  }

  for (let j = 0; j < frame.entities.length; j++) {
    const e: EntityDraw = frame.entities[j]
    out.push(
      `entity ${j} entityId=${n(e.entityId)} kind=${s(e.kind)} visible=${e.visible}` +
        ` position=${v(e.position)} heading=${n(e.heading)} scale=${n(e.scale)}`,
    )
  }

  const c: CameraState = frame.camera
  out.push(
    `camera position=${v(c.position)} lookAt=${v(c.lookAt)} up=${v(c.up)}` +
      ` fovDegrees=${n(c.fovDegrees)} mode=${s(c.mode)}`,
  )

  out.push(
    `hud place=${n(hud.place)} lap=${n(hud.lap)} speedKph=${n(hud.speedKph)}` +
      ` countdownLabel=${s(hud.countdownLabel)} raceClock=${s(hud.raceClock)}`,
  )

  for (let b = 0; b < frame.itemBoxAlpha.length; b++) {
    out.push(`itembox ${b} alpha=${n(frame.itemBoxAlpha[b])}`)
  }

  return `${out.join('\n')}\n`
}
```

Now generate the recorded file — it is **never hand-written**:

```bash
UPDATE_GOLDEN=1 npx vitest run packages/game/test/golden-frame.test.ts
```

Expect: 3 passing, and `packages/render/test/fixtures/golden-frame.txt` now
exists. Inspect it before committing:

```bash
wc -l packages/render/test/fixtures/golden-frame.txt
head -3 packages/render/test/fixtures/golden-frame.txt
```

Expect: **58** lines for `caldera` — 8 karts + 32 entities + 1 camera + 1 hud + 16
item boxes, one line each, and `caldera` ships 16 boxes, and a first line of the shape
`kart 0 playerId=0.000000 visible=true position=…`. If `kart 0` reads
`visible=false` or every `entity` line reads `visible=false`, **stop**: the
fixture would be frozen over nothing, and the third test above will say so.

- [ ] **Step 6: Run everything**

```bash
npx vitest run packages/game/test/golden-frame.test.ts
npx vitest run
npx tsc --noEmit -p apps/web/tsconfig.json
npm run typecheck
```

Expected: the golden test passes without `UPDATE_GOLDEN`, the whole repository
suite is green, and both typechecks print nothing.

**What each check catches, and whether it would actually fail under that bug:**

| Check | Bug | Fails? |
|---|---|---|
| `realpathSync('node_modules/@tapkart/web')` | the root `workspaces` edit forgotten, so `apps/web` typechecks against nothing | yes — the path does not resolve |
| `tsc -p apps/web` | a missing `exports` entry, or `@tapkart/game` pulling a DOM-free package into a DOM context | yes |
| `curl … grep -c tk-canvas` | the dev server not serving, or `fs.allow` missing so a track import 403s | yes for the first; the second surfaces as a console error in the operator check |
| operator check | the whole reason Plan 3 exists: that this is a game a human can play | this is the only check that can see it (§8.3) |
| operator check, item 3a | **a missing ground plane, uncoloured pads and ramps, or undrawn item boxes** — three things the pure layer produces (`theme.ground`, baked vertex colours, `TrackScene.itemBoxes`) and only the Three.js adapter consumes | yes, and **only here**: CI never imports the adapter, so a `setScene` that silently dropped any of the three would ship a ribbon floating over the sky with invisible pickups and every test still green |
| golden byte-identity | any regression in `buildRenderFrame`, `updateCamera`, `buildHudModel`, `ViewBuilder.build` or `RaceSession` that moves a derived number | yes, with the first differing line named |
| golden determinism | a clock, a random number, or leaked module-scope state in the frame path | yes — and it is why `resetBotHold()` is called at the top of every run |
| golden covers something | **the failure mode this project keeps shipping**: a fixture frozen over eight invisible karts and zero entities, byte-stable forever, detecting nothing | yes — `visible=true`, a non-zero `wheelSpin` and at least one visible entity are asserted, so the net cannot quietly become decoration |

- [ ] **Step 7: Commit**

```bash
git add package-lock.json apps/web \
        packages/render/test/fixtures/golden-frame.ts \
        packages/render/test/fixtures/golden-frame.txt \
        packages/game/test/golden-frame.test.ts && \
git commit -m "feat(web): Vite shell a human can open, and the golden RenderFrame fixture"
```
