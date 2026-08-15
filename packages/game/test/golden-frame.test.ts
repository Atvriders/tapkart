import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent, SimContext } from '@tapkart/sim'
import { COUNTDOWN_TICKS, RACE_LAPS, spawnEntity } from '@tapkart/sim'
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
import {
  GOLDEN_FRAME_FILE,
  serializeDerivedFrame,
} from '../../render/test/fixtures/golden-frame'

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
  spawnEntity(
    ctx,
    st,
    'slick',
    4,
    {
      x: slickOwner.position.x + 3,
      y: slickOwner.position.y,
      z: slickOwner.position.z + 3,
    },
    0.5,
    -1,
    900,
    events,
  )
  st.karts[2].shielded = true
  const bubbleOwner = st.karts[2]
  spawnEntity(
    ctx,
    st,
    'bubble',
    2,
    { x: bubbleOwner.position.x, y: bubbleOwner.position.y, z: bubbleOwner.position.z },
    0,
    -1,
    900,
    events,
  )

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
        expect(`line ${i + 1}: ${a[i] ?? '<missing>'}`).toBe(
          `line ${i + 1}: ${e[i] ?? '<missing>'}`,
        )
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
    const entities = lines.filter(
      (l) => l.startsWith('entity ') && l.includes('visible=true'),
    )
    expect(kart0).toContain('visible=true')
    expect(kart0).not.toContain('wheelSpin=0.000000')
    expect(entities.length).toBeGreaterThan(0)
    expect(lines.some((l) => l.startsWith('camera '))).toBe(true)
    expect(lines.some((l) => l.startsWith('hud '))).toBe(true)
    expect(lines.some((l) => l.startsWith('itembox 0 '))).toBe(true)
  })
})
