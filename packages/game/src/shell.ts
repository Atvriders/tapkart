// ADAPTER — thin, untestable, never imported by CI (§8.2). requestAnimationFrame,
// canvas sizing, DOM mounting and the orientation overlay live here and nowhere
// else in packages/game except controls/source.ts.
//
// It contains NO game decisions: every branch it would want is a field on
// RenderFrame, HudModel or AppState, and the buttons it draws come from
// SCREEN_TRANSITIONS — the reducer's own table — so the two cannot disagree.
import type { Intent, SimContext } from '@tapkart/sim'
import { MAX_KARTS, RACE_LAPS } from '@tapkart/sim'
import type { StartMessage, WelcomeMessage } from '@tapkart/protocol'
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
import {
  SCREEN_TRANSITIONS,
  SERVER_LOST_RACE_WARNING,
  SERVER_LOST_RECOVERY_MESSAGE,
  canAcceptInvite,
  canChooseTrack,
  canRequestStart,
  createAppState,
  reduceApp,
} from './app'
// AMENDMENT 4: the accumulator is @tapkart/net's, because packages/server runs the
// same fixed-step pump and net may not import game. This file imports it from net
// exactly as the server will, and it takes an elapsed DELTA -- so this file, the
// only frame loop in the plan, is what owns `lastNowMs`. TICK_MS is NOT imported
// here and must never be: game/clock.ts is its only importer in the repository, and
// clock.test.ts scans every packages/*/src tree on every run to keep that true.
// Room codes come from @tapkart/protocol for the same one-copy reason.
import {
  DEFAULT_ICE_SERVERS,
  HARD_RESYNC_LIMIT,
  HARD_RESYNC_WINDOW_TICKS,
  advanceAccumulator,
  makeTickAccumulator,
} from '@tapkart/net'
import { browserRtcFactory } from '@tapkart/net/webrtc-browser'
import { browserWebSocket } from '@tapkart/net/websocket-browser'
import { ROOM_CODE_LENGTH, normalizeRoomCode } from '@tapkart/protocol'
import {
  buildInviteUri,
  buildQrMatrix,
  nullNfcHost,
  parseInviteUri,
  qrModuleAt,
  QR_QUIET_ZONE,
  type NfcHost,
} from '@tapkart/invite'
import type { FrameClock } from './clock'
import { accumulatorAlpha } from './clock'
import type { ControlAdapter, ControlInputs, TiltSample, Viewport } from './controls/types'
import { createControlInputs } from './controls/types'
import type { ControlConfig, Rect } from './controls/config'
import {
  DEFAULT_CONTROL_CONFIG,
  TOUCH_BUTTON_MARGIN_PX,
  brakeButtonRect,
  driftButtonRect,
  gasButtonRect,
  itemButtonRect,
  steeringZoneRect,
} from './controls/config'
import { makeControlAdapter } from './controls/index'
import { attachInputSource, requestTiltPermission } from './controls/source'
import { calibrateTilt } from './controls/tilt'
import { createSoloTransport } from './localinput'
import type { MultiplayerRoom } from './multiplayer'
import { createMultiplayerRoom } from './multiplayer'
import { createMultiplayerSession } from './multiplayer-session'
import { buildResultRows } from './results'
import type { KeyValueStore, Settings } from './settings'
import {
  PLAYER_NAME_MAX,
  loadSettings,
  normalizePlayerName,
  saveSettings,
} from './settings'
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
  /** Optional so browser and headless call sites remain inert. */
  nfc?: NfcHost
  /** Browser defaults to location.origin. Native passes the deployed HTTPS
   * origin for invites and networking instead of its capacitor:// asset origin. */
  origin?: string
}

export interface GameShell {
  stop(): void
  setAudio(next: AudioBackend): void
  onIdle(cb: () => void): void
  onRaceStateChange(cb: (racing: boolean) => void): void
}

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
  'serverLostDuringRace',
  'serverStartReceived',
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

/** Draws a black-on-white symbol including the QR-standard quiet zone. */
function drawQr(canvas: HTMLCanvasElement, text: string): void {
  const matrix = buildQrMatrix(text)
  const modules = matrix.size + QR_QUIET_ZONE * 2
  const scale = Math.max(2, Math.floor(320 / modules))
  canvas.width = modules * scale
  canvas.height = modules * scale
  canvas.style.width = `${canvas.width}px`
  canvas.style.height = `${canvas.height}px`

  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#000000'
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (!qrModuleAt(matrix, x, y)) continue
      ctx.fillRect(
        (x + QR_QUIET_ZONE) * scale,
        (y + QR_QUIET_ZONE) * scale,
        scale,
        scale,
      )
    }
  }
}

/** The lobby's three simultaneous invite fallbacks: tap, QR, and the existing
 * room-code element mounted by renderScreen. */
function mountInvitePanel(
  host: HTMLElement,
  args: { origin: string; roomCode: string; nfc: NfcHost },
): () => void {
  const panel = document.createElement('div')
  panel.setAttribute('data-testid', 'invite-panel')

  const tap = document.createElement('p')
  tap.setAttribute('data-testid', 'invite-tap')
  tap.textContent = 'Hold another phone against the back of this one to join.'
  panel.appendChild(tap)

  let uri: string
  try {
    uri = buildInviteUri(args.origin, args.roomCode)
  } catch {
    // Local development is intentionally plain HTTP. Keep the typed room code
    // usable there without weakening buildInviteUri's production HTTPS rule.
    tap.textContent = 'Type the room code on the other device to join.'
    host.appendChild(panel)
    return () => panel.remove()
  }

  const qr = document.createElement('canvas')
  qr.setAttribute('data-testid', 'invite-qr')
  panel.appendChild(qr)
  drawQr(qr, uri)
  host.appendChild(panel)

  void args.nfc.advertise(uri).catch(() => {
    // QR and the typed room code remain available when NFC is absent or off.
    tap.textContent = 'Scan the code or type it in to join.'
  })

  return () => {
    void args.nfc.stop().catch(() => undefined)
    panel.remove()
  }
}

function webSocketUrl(origin: string): string {
  const url = new URL('/ws', origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function sessionTokenKey(roomCode: string): string {
  return `tapkart.session.${roomCode}`
}

function welcomeError(message: WelcomeMessage): string {
  switch (message.result) {
    case 'roomNotFound': return 'Room not found.'
    case 'roomFull': return 'That room is full.'
    case 'roomClosed': return 'That room is closed.'
    case 'versionMismatch': return 'This game version cannot join that room.'
    case 'rateLimited': return 'Too many join attempts. Try again shortly.'
    case 'badRequest': return 'The room request was invalid.'
    case 'ok': return ''
  }
}

/** requestAnimationFrame loop, in this exact order:
 *    inputSource.drain -> advanceAccumulator -> N x (adapter.sample +
 *    session.tickOnce), with viewBuilder.build(1) after every non-final catch-up
 *    tick -> updateCamera(N ticks) -> the final viewBuilder.build(alpha) ->
 *    buildRenderFrame -> renderer.applyFrame -> buildHudModel -> DOM ->
 *    buildAudioModel -> activeAudio.apply -> session.swapViews.
 *
 *  Two things it does outside that loop: it calls activeAudio.setConfig on every
 *  Settings change and once at startup (R38 — never per frame), and it shows the
 *  rotate-your-device overlay while viewport.height > viewport.width (R40),
 *  skipping renderer.resize until the device is landscape again. */
export function startShell(opts: ShellOptions): GameShell {
  const { canvas, root, clock, store, renderer } = opts
  const nfc: NfcHost = opts.nfc ?? nullNfcHost
  const origin: string = opts.origin ?? window.location.origin
  let activeAudio = opts.audio
  // One allocation for every non-race transition. Reusing it also guarantees
  // that no stale cue can survive from the race model.
  const silentAudioModel = createAudioModel()

  // Plan 4's `race-canvas`. Set on the caller's canvas rather than on a wrapper:
  // the spec's comment is "the canvas startShell renders into", and a hook on a
  // div around it would pass the locator while proving nothing about the canvas.
  canvas.setAttribute('data-testid', TESTIDS.raceCanvas)

  const screenEl = document.createElement('div')
  screenEl.className = 'tk-screen'
  // Menu/form gestures are UI, not buffered race input. Without this boundary,
  // tapping START can become the first steering pointer of the race.
  for (const kind of [
    'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'keyup',
  ]) {
    screenEl.addEventListener(kind, (event) => event.stopPropagation())
  }
  const hudEl = document.createElement('div')
  hudEl.className = 'tk-hud'
  const rotateEl = document.createElement('div')
  rotateEl.className = 'tk-rotate'
  rotateEl.textContent = 'Rotate your device'

  // A visual map of the exact pure hit geometry. It never receives race input:
  // pointer events pass through to the canvas/window source, except for QUIT,
  // whose pointer sequence is stopped locally before it can become steering.
  const controlsEl = document.createElement('div')
  controlsEl.className = 'tk-controls tk-hidden'
  controlsEl.setAttribute('data-control-overlay', '')
  const steerGuideEl = document.createElement('div')
  steerGuideEl.className = 'tk-steer-guide'
  steerGuideEl.setAttribute('data-control', 'steer')
  steerGuideEl.setAttribute('aria-hidden', 'true')

  function affordance(name: string, label: string): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'tk-control-affordance'
    el.setAttribute('data-control', name)
    el.setAttribute('aria-hidden', 'true')
    el.textContent = label
    return el
  }

  const driftControlEl = affordance('drift', 'DRIFT')
  const itemControlEl = affordance('item', 'ITEM')
  const gasControlEl = affordance('gas', 'GAS')
  const brakeControlEl = affordance('brake', 'BRAKE')
  const raceQuitEl = button('QUIT', () => dispatch({ kind: 'quitToTitle' }))
  raceQuitEl.classList.add('tk-race-quit')
  raceQuitEl.setAttribute('data-action', 'quit-race')
  raceQuitEl.setAttribute('aria-label', 'Quit race')
  for (const kind of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    raceQuitEl.addEventListener(kind, (event) => event.stopPropagation())
  }
  controlsEl.append(
    steerGuideEl,
    driftControlEl,
    itemControlEl,
    gasControlEl,
    brakeControlEl,
    raceQuitEl,
  )
  root.append(screenEl, hudEl, controlsEl, rotateEl)

  let settings = loadSettings(store)
  let app: AppState = createAppState(settings)
  // R38: once at startup and on every Settings change, never per frame.
  activeAudio.setConfig({ masterGain: settings.audioVolume, enabled: settings.audioEnabled })

  const viewport: Viewport = { width: window.innerWidth, height: window.innerHeight }
  const inputSource = attachInputSource(window, viewport)
  const calibrationSample: TiltSample = { alpha: 0, beta: 0, gamma: 0 }
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
  let multiplayer: MultiplayerRoom | null = null
  let pendingStart: StartMessage | null = null
  const hardResyncTicks: number[] = []
  let lastW = -1
  let lastH = -1
  let lastDpr = -1
  let running = true
  let rafId = 0
  let idleCallback: (() => void) | null = null
  let raceStateCallback: ((racing: boolean) => void) | null = null
  let unmountInvitePanel: (() => void) | null = null
  let localReady = false
  let readerWanted: boolean | null = null
  let settingsNotice = ''
  let settingsExpanded = false
  let tiltCalibrationPending = false
  let tiltPermissionRequest = 0
  let controlsW = -1
  let controlsH = -1
  let controlsScheme: Settings['scheme'] | null = null

  const steerOverlayRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const driftOverlayRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const itemOverlayRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const gasOverlayRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const brakeOverlayRect: Rect = { x: 0, y: 0, w: 0, h: 0 }

  function placeControl(el: HTMLElement, rect: Rect): void {
    el.style.left = `${rect.x}px`
    el.style.top = `${rect.y}px`
    el.style.width = `${rect.w}px`
    el.style.height = `${rect.h}px`
  }

  function syncRaceControls(portrait: boolean): void {
    const visible = app.screen === 'race' && !portrait
    controlsEl.classList.toggle('tk-hidden', !visible)
    if (!visible) return
    if (
      controlsW === viewport.width &&
      controlsH === viewport.height &&
      controlsScheme === settings.scheme
    ) return

    controlsW = viewport.width
    controlsH = viewport.height
    controlsScheme = settings.scheme
    controlsEl.setAttribute('data-scheme', settings.scheme)
    steeringZoneRect(viewport, steerOverlayRect)
    driftButtonRect(viewport, driftOverlayRect)
    itemButtonRect(viewport, itemOverlayRect)
    gasButtonRect(viewport, gasOverlayRect)
    brakeButtonRect(viewport, brakeOverlayRect)
    placeControl(steerGuideEl, steerOverlayRect)
    placeControl(driftControlEl, driftOverlayRect)
    placeControl(itemControlEl, itemOverlayRect)
    placeControl(gasControlEl, gasOverlayRect)
    placeControl(brakeControlEl, brakeOverlayRect)
    steerGuideEl.textContent = settings.scheme === 'tilt'
      ? 'TILT PHONE ↔ TO STEER'
      : settings.scheme === 'virtualStick'
        ? 'VIRTUAL STICK · TOUCH + SLIDE ↔'
        : 'TOUCH + SLIDE ↔ TO STEER'
    const pedals = settings.scheme === 'virtualStick'
    gasControlEl.classList.toggle('tk-hidden', !pedals)
    brakeControlEl.classList.toggle('tk-hidden', !pedals)
    raceQuitEl.style.top = `${TOUCH_BUTTON_MARGIN_PX}px`
    raceQuitEl.style.right = `${TOUCH_BUTTON_MARGIN_PX}px`
  }

  function reconcileReader(): void {
    const wanted = canAcceptInvite(app)
    if (wanted === readerWanted) return
    readerWanted = wanted
    void (wanted ? nfc.startReader() : nfc.stopReader()).catch(() => undefined)
  }

  function closeMultiplayer(): void {
    const old = multiplayer
    multiplayer = null
    pendingStart = null
    hardResyncTicks.length = 0
    localReady = false
    old?.close()
  }

  function multiplayerPlayerName(role: 'host' | 'guest'): string {
    return settings.playerName === '' ? (role === 'host' ? 'Host' : 'Guest') : settings.playerName
  }

  function beginMultiplayer(role: 'host' | 'guest', roomCode: string): void {
    closeMultiplayer()
    let next: MultiplayerRoom
    try {
      next = createMultiplayerRoom({
        socket: browserWebSocket(webSocketUrl(origin)),
        rtcFactory: browserRtcFactory,
        iceServers: DEFAULT_ICE_SERVERS,
        role,
        name: multiplayerPlayerName(role),
        characterIdx: settings.characterIdx,
        roomCode,
        token: roomCode === '' ? '' : store.get(sessionTokenKey(roomCode)) ?? '',
        trackId: role === 'host' ? app.trackId : '',
      })
    } catch {
      dispatch({ kind: 'connectFailed', message: 'Could not open the multiplayer connection.' })
      return
    }
    multiplayer = next

    next.onWelcome((message) => {
      if (multiplayer !== next) return
      if (message.result !== 'ok') {
        dispatch({ kind: 'connectFailed', message: welcomeError(message) })
        return
      }
      store.set(sessionTokenKey(message.roomCode), message.token)
      dispatch({
        kind: 'connected',
        roomCode: message.roomCode,
        localPlayerId: message.playerId,
        role: next.state().role,
      })
      // The multiplayer E2E (and a returning player) already has a saved choice;
      // do not force a second character-selection stop after the handshake.
      dispatch({ kind: 'characterChosen', characterIdx: settings.characterIdx })
      // An edit made while the hello was in flight could not be sent yet. The
      // post-welcome update makes the persisted field authoritative either way.
      // Use the server-confirmed role: a reconnect token can restore the room
      // creator even though the deep-link/typed entry path requested `guest`.
      next.update({ name: multiplayerPlayerName(next.state().role) })
    })
    next.onLobby((message) => {
      if (multiplayer !== next) return
      const slots = message.slots.map((slot, playerId) => ({
        playerId: slot.occupied ? playerId : -1,
        name: slot.name,
        characterIdx: slot.characterIdx,
        isBot: slot.isBot,
        connected: slot.connected,
        ready: slot.ready,
      }))
      const local = message.slots[app.localPlayerId]
      if (local !== undefined && local.occupied) localReady = local.ready
      dispatch({ kind: 'lobbyUpdated', slots, trackId: message.trackId })
    })
    next.onStart((message) => {
      if (multiplayer !== next) return
      pendingStart = message
      // StartMessage is the final server truth, including for a guest whose last
      // lobby frame raced the start frame.
      dispatch({ kind: 'lobbyUpdated', slots: app.slots, trackId: message.trackId })
      if (app.screen === 'race' || app.screen === 'results') {
        dispatch({ kind: 'serverStartReceived' })
      }
      dispatch({ kind: 'raceStarting' })
    })
    next.onClosed((reason) => {
      if (multiplayer !== next || reason === 'closed') return
      dispatch({ kind: 'connectFailed', message: reason === 'roomNotFound' ? 'Room not found.' : 'The room connection closed.' })
    })
    next.start()
  }

  function startRace(st: AppState): Race {
    // A ControlAdapter is intentionally shared across screens. Clear every
    // held pointer/key and edge latch before a new simulation consumes it.
    adapter.reset()
    const serverStart = st.role === 'solo' ? null : pendingStart
    if (st.role !== 'solo' && (serverStart === null || multiplayer === null)) {
      throw new Error('startRace: multiplayer requires the server StartMessage and a live room')
    }
    const loaded = loadTrack(serverStart?.trackId ?? st.trackId)
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
    const characterIdx: number[] = serverStart?.characterIdx.slice() ?? []
    if (serverStart === null) {
      for (let i = 0; i < MAX_KARTS; i++) {
        characterIdx.push(i === st.localPlayerId ? st.settings.characterIdx : i % CHARACTERS.length)
      }
    }

    const localPlayerId = st.localPlayerId >= 0 ? st.localPlayerId : 0
    const session = serverStart === null
      ? createSession({
        role: 'solo',
        ctx,
        localPlayerId,
        seed: seedFor(st.roomCode),
        characterIdx,
        transport: createSoloTransport(),
      })
      : createMultiplayerSession({
        room: multiplayer!,
        role: st.role === 'host' ? 'host' : 'guest',
        ctx,
        localPlayerId,
        start: serverStart,
      })
    if (st.role !== 'solo') {
      session.onHardResync((tick) => {
        hardResyncTicks.push(tick)
        while (
          hardResyncTicks.length > 0 &&
          tick - hardResyncTicks[0] > HARD_RESYNC_WINDOW_TICKS
        ) hardResyncTicks.shift()
        if (hardResyncTicks.length >= HARD_RESYNC_LIMIT) {
          multiplayer?.requestResync('divergence', tick)
          hardResyncTicks.length = 0
        }
      })
    }

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

  function silenceAudio(): void {
    activeAudio.apply(silentAudioModel)
  }

  function disposeInvitePanel(): void {
    if (unmountInvitePanel === null) return
    unmountInvitePanel()
    unmountInvitePanel = null
  }

  function endRace(): void {
    if (race === null) return
    // Results/title frames continue draining DOM input without sampling the
    // adapter. Reset here so a held drift, pedal or stick cannot leak into a
    // rematch even if its release happened between races.
    adapter.reset()
    // The last race model may contain both continuous gain and one-frame cues.
    // Clear it before the session and its views become unreachable.
    silenceAudio()
    race.session.close()
    race = null
    hudEl.replaceChildren()
    raceStateCallback?.(false)
  }

  function dispatch(ev: AppEvent): void {
    // HOST/JOIN/SOLO are mutually exclusive compositions. A player can switch
    // while a WebSocket handshake is still pending; detach that room first so
    // its late Welcome cannot overwrite the newly selected mode.
    if (
      ev.kind === 'connectFailed' || ev.kind === 'quitToTitle' ||
      ev.kind === 'hostPressed' || ev.kind === 'joinPressed' || ev.kind === 'soloPressed'
    ) closeMultiplayer()
    const next = reduceApp(app, ev)
    if (next === app) return // an illegal event is an identity no-op, by reference
    const prevScreen = app.screen
    app = next
    reconcileReader()

    if (next.settings !== settings) {
      settings = next.settings
      saveSettings(store, settings)
      activeAudio.setConfig({ masterGain: settings.audioVolume, enabled: settings.audioEnabled })
      adapter = makeControlAdapter(settings.scheme, controlConfigFor(settings))
      adapter.reset()
    }
    if (next.screen !== prevScreen) {
      if (next.screen === 'race') {
        race = startRace(next)
        raceStateCallback?.(true)
      } else {
        endRace()
      }
    }
    renderScreen()
    if (next.screen !== prevScreen && (next.screen === 'results' || next.screen === 'title')) {
      idleCallback?.()
    }
  }

  function joinByCode(code: string): void {
    if (app.role !== 'guest') dispatch({ kind: 'joinPressed' })
    dispatch({ kind: 'roomCodeEntered', code })
    if (app.connecting && app.role === 'guest') beginMultiplayer('guest', app.roomCode)
  }

  // Both live plugin events and a cold-start launch URI enter the same parser
  // and connection path as the typed room-code form.
  function handleInvite(uri: string): void {
    if (!running) return
    const invite = parseInviteUri(uri)
    if (invite === null || invite.origin !== origin || !canAcceptInvite(app)) return
    joinByCode(invite.roomCode)
  }

  const offInvite = nfc.onInvite(handleInvite)
  reconcileReader()
  void nfc.pendingInvite().then((uri) => {
    if (uri !== null) handleInvite(uri)
  }).catch(() => undefined)

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
      tiltPermissionRequest++
      tiltCalibrationPending = false
      settingsNotice = ''
      dispatch({ kind: 'settingsChanged', settings: { ...settings, scheme } })
      return
    }
    // Q22: request permission from this user gesture, but do not select tilt
    // until a later CALIBRATE gesture snapshots a real sensor sample.
    const request = ++tiltPermissionRequest
    tiltCalibrationPending = false
    settingsNotice = 'Requesting motion access…'
    renderScreen()
    void requestTiltPermission().then((granted) => {
      if (!running || request !== tiltPermissionRequest) return
      if (granted) {
        tiltCalibrationPending = true
        settingsNotice = 'Hold the phone in your neutral driving position, then tap CALIBRATE.'
      } else {
        // This is settings-local, never a connection failure. In particular, a
        // host can deny the OS prompt without destroying the live room.
        tiltCalibrationPending = false
        settingsNotice = 'Motion access was denied. Your previous controls are still selected.'
      }
      renderScreen()
    })
  }

  function calibrateSelectedTilt(): void {
    if (!tiltCalibrationPending) return
    if (!inputSource.snapshotTilt(calibrationSample)) {
      settingsNotice = 'No motion reading yet. Keep the phone neutral and tap CALIBRATE again.'
      renderScreen()
      return
    }
    tiltCalibrationPending = false
    settingsNotice = 'Tilt steering calibrated.'
    dispatch({
      kind: 'settingsChanged',
      settings: {
        ...settings,
        scheme: 'tilt',
        tiltCalibration: calibrateTilt(calibrationSample),
      },
    })
  }

  function renderScreen(): void {
    // Re-rendering the same lobby (ready/settings/track changes) must not race a
    // stop against a fresh advertise call. Re-advertising the same/current URI
    // is idempotent; the disposer runs only when the invite ceases to be live.
    if (app.screen !== 'lobby' || app.role !== 'host' || app.roomCode === '') {
      disposeInvitePanel()
    }
    screenEl.replaceChildren()
    syncRaceControls(viewport.height > viewport.width)
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
          button(descriptors[idx].name, () => {
            dispatch({ kind: 'characterChosen', characterIdx: idx })
            multiplayer?.update({ characterIdx: idx })
          }),
        )
      }
      screenEl.append(row)
    }

    if (legal.includes('trackChosen') && canChooseTrack(app)) {
      const sel = document.createElement('select')
      sel.setAttribute('aria-label', 'Track')
      for (const entry of TRACK_MANIFEST) {
        const o = document.createElement('option')
        o.value = entry.id
        o.textContent = entry.name
        if (entry.id === app.trackId) o.selected = true
        sel.append(o)
      }
      sel.addEventListener('change', () => {
        dispatch({ kind: 'trackChosen', trackId: sel.value })
        multiplayer?.update({ trackId: sel.value })
      })
      screenEl.append(sel)
    }

    if (legal.includes('roomCodeEntered') && app.role === 'guest') {
      const input = document.createElement('input')
      input.placeholder = 'ROOM CODE'
      input.maxLength = ROOM_CODE_LENGTH
      input.setAttribute('data-testid', TESTIDS.roomCodeInput)
      const go = button(
        'GO',
        () => {
          joinByCode(normalizeRoomCode(input.value))
        },
        TESTIDS.roomCodeSubmit,
      )
      screenEl.append(input, go)
    }

    if (legal.includes('settingsChanged')) {
      const panel = document.createElement('section')
      panel.className = 'tk-settings'
      panel.setAttribute('aria-label', 'Settings')
      const expanded = settingsExpanded || tiltCalibrationPending || settingsNotice !== ''
      panel.setAttribute('data-expanded', String(expanded))
      const settingsToggle = button('SETTINGS', () => {
        if (expanded) {
          settingsExpanded = false
          settingsNotice = ''
          tiltPermissionRequest++
          tiltCalibrationPending = false
        } else {
          settingsExpanded = true
        }
        renderScreen()
      })
      settingsToggle.classList.add('tk-settings-toggle')
      settingsToggle.setAttribute('aria-expanded', String(expanded))
      const settingsContent = document.createElement('div')
      settingsContent.className = 'tk-settings-content'
      settingsContent.classList.toggle('tk-hidden', !expanded)
      panel.append(settingsToggle, settingsContent)

      const identityRow = document.createElement('div')
      identityRow.className = 'tk-row tk-settings-fields'
      const nameLabel = document.createElement('label')
      nameLabel.textContent = 'PLAYER NAME '
      const nameInput = document.createElement('input')
      nameInput.type = 'text'
      nameInput.value = settings.playerName
      nameInput.placeholder = 'Host / Guest'
      nameInput.maxLength = PLAYER_NAME_MAX
      nameInput.setAttribute('autocomplete', 'nickname')
      nameInput.setAttribute('aria-label', 'Player name')
      nameInput.setAttribute('data-setting', 'player-name')
      nameInput.addEventListener('change', () => {
        const playerName = normalizePlayerName(nameInput.value)
        if (playerName === null) {
          settingsNotice = `Name must fit ${PLAYER_NAME_MAX} characters and the multiplayer limit.`
          renderScreen()
          return
        }
        settingsNotice = ''
        dispatch({ kind: 'settingsChanged', settings: { ...settings, playerName } })
        if (app.role === 'host' || app.role === 'guest') {
          multiplayer?.update({ name: multiplayerPlayerName(app.role) })
        }
      })
      nameLabel.append(nameInput)

      const volumeLabel = document.createElement('label')
      const volumeValue = document.createElement('span')
      volumeValue.textContent = `VOLUME ${Math.round(settings.audioVolume * 100)}% `
      const volumeInput = document.createElement('input')
      volumeInput.type = 'range'
      volumeInput.min = '0'
      volumeInput.max = '1'
      volumeInput.step = '0.05'
      volumeInput.value = String(settings.audioVolume)
      volumeInput.setAttribute('aria-label', 'Audio volume')
      volumeInput.setAttribute('data-setting', 'audio-volume')
      volumeInput.addEventListener('change', () => {
        const audioVolume = Number(volumeInput.value)
        if (!Number.isFinite(audioVolume) || audioVolume < 0 || audioVolume > 1) return
        settingsNotice = ''
        dispatch({ kind: 'settingsChanged', settings: { ...settings, audioVolume } })
      })
      volumeLabel.append(volumeValue, volumeInput)
      identityRow.append(nameLabel, volumeLabel)
      settingsContent.append(identityRow)

      const row = document.createElement('div')
      row.className = 'tk-row'
      for (const scheme of ['thumbZones', 'tilt', 'virtualStick'] as const) {
        const b = button(scheme, () => selectScheme(scheme))
        if (settings.scheme === scheme) b.classList.add('tk-on')
        b.setAttribute('aria-pressed', String(settings.scheme === scheme))
        b.setAttribute('data-setting', `scheme-${scheme}`)
        row.append(b)
      }
      if (tiltCalibrationPending) {
        const calibrate = button('CALIBRATE', calibrateSelectedTilt)
        calibrate.setAttribute('data-setting', 'calibrate-tilt')
        row.append(calibrate)
      }
      if (settings.scheme === 'tilt') {
        const invert = button(
          settings.invertTilt ? 'INVERT TILT ON' : 'INVERT TILT OFF',
          () => {
            settingsNotice = ''
            dispatch({
              kind: 'settingsChanged',
              settings: { ...settings, invertTilt: !settings.invertTilt },
            })
          },
        )
        invert.setAttribute('aria-pressed', String(settings.invertTilt))
        invert.setAttribute('data-setting', 'invert-tilt')
        row.append(invert)
      }
      const audioToggle = button(
        settings.audioEnabled ? 'AUDIO ON' : 'AUDIO OFF',
        () => {
          settingsNotice = ''
          dispatch({
            kind: 'settingsChanged',
            settings: { ...settings, audioEnabled: !settings.audioEnabled },
          })
        },
      )
      audioToggle.setAttribute('aria-pressed', String(settings.audioEnabled))
      audioToggle.setAttribute('data-setting', 'audio-enabled')
      row.append(audioToggle)
      settingsContent.append(row)
      if (settingsNotice !== '') {
        const notice = document.createElement('p')
        notice.className = 'tk-settings-note'
        notice.setAttribute('data-settings-note', '')
        notice.setAttribute('role', 'status')
        notice.textContent = settingsNotice
        settingsContent.append(notice)
      }
      screenEl.append(panel)
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

    // A solo lobby deliberately has no room code. Only a connected host/guest
    // room can produce a valid invite URI; Plan 4 supplies that connection.
    if (app.screen === 'lobby' && app.role === 'host' && app.roomCode !== '') {
      unmountInvitePanel = mountInvitePanel(screenEl, {
        origin,
        roomCode: app.roomCode,
        nfc,
      })
    }

    if (app.screen === 'lobby') {
      const occupied = app.slots.filter((slot) => slot.playerId !== -1)
      if (occupied.length > 0) {
        const players = document.createElement('ul')
        players.className = 'tk-lobby-players'
        players.setAttribute('aria-label', 'Lobby players')
        for (const slot of occupied) {
          const player = document.createElement('li')
          player.textContent = `${slot.name}${slot.ready ? ' · READY' : ''}`
          players.append(player)
        }
        screenEl.append(players)
      }
    }

    if (app.screen === 'lobby') {
      const ready = button(
        localReady ? 'READY ✓' : 'READY',
        () => {
          localReady = !localReady
          multiplayer?.update({ ready: localReady })
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
      if (kind === 'raceStarting' && !canRequestStart(app)) continue
      const label = BUTTON_LABELS[kind] ?? kind
      actions.append(
        button(
          label,
          () => {
            if (kind === 'hostPressed') {
              dispatch({ kind: 'hostPressed' })
              beginMultiplayer('host', '')
              return
            }
            if (kind === 'raceStarting' && app.role === 'host') {
              multiplayer?.requestStart()
              return
            }
            if (kind === 'backToLobby') {
              if (app.serverLost) {
                dispatch({ kind: 'connectFailed', message: SERVER_LOST_RECOVERY_MESSAGE })
                return
              }
              multiplayer?.returnToLobby()
            }
            dispatch({ kind } as AppEvent)
          },
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
  const hudConnection = document.createElement('div')
  hudConnection.className = 'tk-error'
  hudCountdown.className = 'tk-countdown'

  function paintHud(hud: HudModel): void {
    if (hudEl.childElementCount === 0) {
      hudEl.append(hudPlace, hudLap, hudSpeed, hudClock, hudItem, hudConnection, hudCountdown)
    }
    hudEl.classList.toggle('tk-hidden', !hud.visible)
    hudPlace.textContent = `${hud.place}/${hud.fieldSize}`
    hudLap.textContent = `LAP ${hud.lap}/${hud.totalLaps}`
    hudSpeed.textContent = `${hud.speedKph} KM/H`
    hudClock.textContent = hud.raceClock
    hudItem.textContent = hud.itemReady ? hud.item.toUpperCase() : ''
    hudConnection.textContent = app.serverLost ? SERVER_LOST_RACE_WARNING : ''
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
    syncRaceControls(portrait)
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
    multiplayer?.poll(nowMs)
    if (multiplayer?.state().serverLost === true && !app.serverLost) {
      dispatch({ kind: 'serverLostDuringRace' })
    }
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
    activeAudio.apply(r.audioModel)
    // AFTER activeAudio.apply, never before: the cues raised by this frame's delta are
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
      multiplayer?.finishRace()
      dispatch({ kind: 'raceFinished', results: buildResultRows(view, app.slots) })
    }
  }

  renderScreen()
  rafId = requestAnimationFrame(frame)

  return {
    stop(): void {
      if (!running) return
      running = false
      cancelAnimationFrame(rafId)
      inputSource.detach()
      readerWanted = false
      void nfc.stopReader().catch(() => undefined)
      disposeInvitePanel()
      offInvite()
      if (race === null) silenceAudio()
      endRace()
      closeMultiplayer()
      renderer.dispose()
      activeAudio.close()
      screenEl.remove()
      hudEl.remove()
      controlsEl.remove()
      rotateEl.remove()
    },
    setAudio(next: AudioBackend): void {
      if (!running) {
        next.setConfig({ masterGain: settings.audioVolume, enabled: settings.audioEnabled })
        next.apply(silentAudioModel)
        next.close()
        return
      }
      if (next === activeAudio) {
        activeAudio.setConfig({
          masterGain: settings.audioVolume,
          enabled: settings.audioEnabled,
        })
        return
      }
      silenceAudio()
      activeAudio.close()
      activeAudio = next
      activeAudio.setConfig({ masterGain: settings.audioVolume, enabled: settings.audioEnabled })
      activeAudio.apply(silentAudioModel)
    },
    onIdle(cb: () => void): void {
      idleCallback = cb
    },
    onRaceStateChange(cb: (racing: boolean) => void): void {
      raceStateCallback = cb
    },
  }
}
