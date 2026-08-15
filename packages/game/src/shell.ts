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
import { ROOM_CODE_LENGTH, normalizeRoomCode } from '@tapkart/protocol'
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
  'roomCodeEntered',
  'connected',
  'connectFailed',
  'lobbyUpdated',
  'characterChosen',
  'trackChosen',
  'settingsChanged',
  'raceTick',
  'raceFinished',
])

const BUTTON_LABELS: Readonly<Record<string, string | undefined>> = {
  hostPressed: 'HOST',
  joinPressed: 'JOIN',
  soloPressed: 'SOLO',
  raceStarting: 'START RACE',
  backToLobby: 'BACK TO LOBBY',
  quitToTitle: 'QUIT TO TITLE',
}

/**
 * CROSS-PLAN E2E CONTRACT WITH THIS SHELL — Plan 4's ten `data-testid` values
 * plus Plan 5's `solo-button`. Renaming one here
 * breaks `e2e/join-and-race.spec.ts` in another plan, and it breaks it silently
 * from this file's point of view: nothing in `packages/game` imports these.
 *
 * `data-testid` rather than a class name or a DOM path because a class is
 * styling and moves; a testid is a contract and does not. `startShell` is an
 * adapter with no vitest coverage by construction (§8.2), so this spec is the
 * only mechanical check that the model ever became a screen.
 *
 * Plan 4's spec is deliberately NOT skipped while it waits — it fails, naming
 * the missing hook — so a wrong or absent value here shows up as red in Plan 5's
 * CI job rather than as a green suite that asserts nothing.
 */
const TESTIDS = {
  hostButton: 'host-button',
  joinButton: 'join-button',
  roomCodeInput: 'room-code-input',
  roomCodeSubmit: 'room-code-submit',
  roomCodeDisplay: 'room-code',
  readyButton: 'ready-button',
  startButton: 'start-button',
  raceCanvas: 'race-canvas',
  lapCounter: 'lap-counter',
  results: 'results',
  soloButton: 'solo-button',
} as const

/** The four transition-table buttons the E2E lanes drive by testid. Everything else
 *  in BUTTON_LABELS is unhooked, which is correct: an E2E asserts the flow it
 *  owns, not every control on the screen. */
const BUTTON_TESTIDS: Readonly<Record<string, string | undefined>> = {
  hostPressed: TESTIDS.hostButton,
  joinPressed: TESTIDS.joinButton,
  soloPressed: TESTIDS.soloButton,
  raceStarting: TESTIDS.startButton,
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
 *    session.tickOnce), with viewBuilder.build(1) after every non-final catch-up
 *    tick -> updateCamera(N ticks) -> the final viewBuilder.build(alpha) ->
 *    buildRenderFrame -> renderer.applyFrame -> buildHudModel -> DOM ->
 *    buildAudioModel -> audio.apply -> session.swapViews.
 *
 *  Two things it does outside that loop: it calls audio.setConfig on every
 *  Settings change and once at startup (R38 — never per frame), and it shows the
 *  rotate-your-device overlay while viewport.height > viewport.width (R40),
 *  skipping renderer.resize until the device is landscape again. */
export function startShell(opts: ShellOptions): GameShell {
  const { canvas, root, clock, store, renderer, audio } = opts

  // Plan 4's `race-canvas`. Set on the caller's canvas rather than on a wrapper:
  // the spec's comment is "the canvas startShell renders into", and a hook on a
  // div around it would pass the locator while proving nothing about the canvas.
  canvas.setAttribute('data-testid', TESTIDS.raceCanvas)

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
  const intent: Intent = {
    tick: 0,
    steer: 0,
    accel: 0,
    brake: false,
    drift: false,
    useItem: false,
  }
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
  /** Plan 4's `ready-button` state. Local only: AppState has no `ready` for the
   *  local player to set and no `readyPressed` event, because readiness is lobby
   *  traffic and the lobby is Plan 4's (§12). This is the flag Plan 4 replaces
   *  with the server's answer — not a shadow copy of one that already exists. */
  let localReady = false

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
    for (let i = 0; i < MAX_KARTS; i++) {
      characterIdx.push(
        st.role === 'solo'
          ? i === st.localPlayerId
            ? st.settings.characterIdx
            : i % CHARACTERS.length
          : st.slots[i].characterIdx,
      )
    }

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
  function button(label: string, onClick: () => void, testId?: string): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'tk-btn'
    b.textContent = label
    if (testId !== undefined) b.setAttribute('data-testid', testId)
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
      if (granted) {
        dispatch({ kind: 'settingsChanged', settings: { ...settings, scheme: 'tilt' } })
      } else {
        dispatch({
          kind: 'connectFailed',
          message: 'Motion access was denied, so tilt steering is unavailable.',
        })
      }
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
      const label = document.createElement('span')
      label.textContent = 'ROOM '
      // Plan 4 reads `textContent` off THIS element and matches it against
      // /^[0-9A-HJKMNP-TV-Z]{5}$/ — anchored. The hooked element therefore
      // carries the five characters ALONE; a `ROOM ABCDE` string on the hooked
      // node fails an assertion that has nothing to do with the room code.
      const value = document.createElement('span')
      value.setAttribute('data-testid', TESTIDS.roomCodeDisplay)
      value.textContent = app.roomCode
      code.append(label, value)
      screenEl.append(code)
    }

    const legal = SCREEN_TRANSITIONS[app.screen]

    if (legal.includes('characterChosen')) {
      const row = document.createElement('div')
      row.className = 'tk-row'
      const descriptors = loadContentBundle().characters
      for (let i = 0; i < descriptors.length; i++) {
        const idx = i
        row.append(
          button(descriptors[idx].name, () =>
            dispatch({ kind: 'characterChosen', characterIdx: idx }),
          ),
        )
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
      sel.addEventListener('change', () =>
        dispatch({ kind: 'trackChosen', trackId: sel.value }),
      )
      screenEl.append(sel)
    }

    if (legal.includes('roomCodeEntered')) {
      const input = document.createElement('input')
      input.placeholder = 'ROOM CODE'
      input.maxLength = ROOM_CODE_LENGTH
      input.setAttribute('data-testid', TESTIDS.roomCodeInput)
      const go = button(
        'GO',
        () => {
          const code = normalizeRoomCode(input.value)
          dispatch({ kind: 'roomCodeEntered', code })
        },
        TESTIDS.roomCodeSubmit,
      )
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
          dispatch({
            kind: 'settingsChanged',
            settings: { ...settings, audioEnabled: !settings.audioEnabled },
          }),
        ),
      )
      screenEl.append(row)
    }

    if (app.screen === 'results') {
      // Plan 4 waits on this element to become visible to decide the race
      // finished, so it exists on the results screen and ONLY there.
      const panel = document.createElement('div')
      panel.setAttribute('data-testid', TESTIDS.results)
      const list = document.createElement('ol')
      for (const r of app.results) {
        const li = document.createElement('li')
        li.textContent = `${r.place}. ${r.name}${r.dnf ? ' — DNF' : ''}`
        list.append(li)
      }
      panel.append(list)
      screenEl.append(panel)
    }

    if (app.screen === 'lobby') {
      // Plan 4's `ready-button`. Plan 3 has no lobby traffic (§12) and no
      // `readyPressed` AppEvent, so this toggles a local flag and nothing more —
      // Plan 4 wires it to the server. The hook is still this plan's obligation:
      // what the E2E asserts is that the control is on the lobby screen.
      const ready = button(
        localReady ? 'READY ✓' : 'READY',
        () => {
          localReady = !localReady
          renderScreen()
        },
        TESTIDS.readyButton,
      )
      screenEl.append(ready)
    }

    const actions = document.createElement('div')
    actions.className = 'tk-row'
    for (const kind of legal) {
      if (PAYLOAD_EVENTS.has(kind)) continue
      const label = BUTTON_LABELS[kind] ?? kind
      actions.append(
        button(
          label,
          () => {
            dispatch({ kind } as AppEvent)
            if (kind === 'hostPressed' || kind === 'joinPressed') {
              dispatch({ kind: 'connectFailed', message: MULTIPLAYER_MESSAGE })
            }
          },
          // `start-button` rides on `raceStarting`, which SCREEN_TRANSITIONS
          // only allows on the lobby screen — so Plan 4's `toHaveCount(0)`
          // assertion for a guest is satisfied by the reducer's own table once
          // Plan 4 makes the event host-only, not by a second rule here.
          BUTTON_TESTIDS[kind],
        ),
      )
    }
    screenEl.append(actions)
  }

  // --- HUD DOM ------------------------------------------------------------
  const hudPlace = document.createElement('div')
  const hudLap = document.createElement('div')
  // Plan 4's `lap-counter`, matched against /[1-3]\s*\/\s*3/ — unanchored, so
  // the `LAP ` prefix below is fine, but the "n/3" pair must stay on THIS node.
  hudLap.setAttribute('data-testid', TESTIDS.lapCounter)
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
      if (i < ticks - 1) {
        // ClientLoop's correction delta describes only its most recent tick.
        // Let ViewBuilder consume every intermediate correction at that tick's
        // endpoint; do not swap the rendered views or emit audio until the
        // final alpha build below.
        r.builder.build(1, r.session.currentView())
      }
    }

    const alpha = accumulatorAlpha(acc)
    // The camera is advanced BEFORE the view is rebuilt, against the newest view
    // there is — the one the previous frame wrote, which is prevView() until
    // this frame swaps. Smoothing is per TICK, so `ticks` is what it takes.
    const newest = r.session.prevView()
    const localId = newest.localPlayerId >= 0 ? newest.localPlayerId : 0
    updateCamera(
      r.cam,
      newest.karts[localId],
      DEFAULT_CAMERA_PARAMS,
      cameraModeFor(newest),
      ticks,
    )

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
