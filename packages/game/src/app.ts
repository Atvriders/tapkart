import type { RacePhase } from '@tapkart/sim'
import { MAX_KARTS } from '@tapkart/sim'
import type { ViewRole } from '@tapkart/render'
import { CHARACTERS, TRACK_MANIFEST } from '@tapkart/content'
import { ROOM_CODE_LENGTH, isValidRoomCode, normalizeRoomCode } from '@tapkart/protocol'
import type { PeerRole } from '@tapkart/protocol'
import type { ResultRow } from './results'
import type { Settings } from './settings'

/** The five application screens. Countdown is a simulation phase rendered on
 * the race screen; host and join are title-screen actions. */
export type ScreenId = 'title' | 'characterSelect' | 'lobby' | 'race' | 'results'

export interface LobbySlot {
  playerId: number
  name: string
  characterIdx: number
  isBot: boolean
  connected: boolean
  ready: boolean
}

export interface AppState {
  screen: ScreenId
  role: ViewRole
  roomCode: string
  trackId: string
  localPlayerId: number
  slots: LobbySlot[]
  settings: Settings
  results: ResultRow[]
  error: string
  connecting: boolean
  serverLost: boolean
}

export const SERVER_LOST_RACE_WARNING =
  'Server connection lost. This race can finish directly, but the room cannot continue.'
export const SERVER_LOST_RECOVERY_MESSAGE =
  'The race finished, but the room could not continue because the server connection was lost.'

export type AppEvent =
  | { kind: 'hostPressed' }
  | { kind: 'joinPressed' }
  | { kind: 'soloPressed' }
  | { kind: 'roomCodeEntered'; code: string }
  | { kind: 'connected'; roomCode: string; localPlayerId: number; role: PeerRole }
  | { kind: 'connectFailed'; message: string }
  | { kind: 'lobbyUpdated'; slots: LobbySlot[]; trackId: string }
  | { kind: 'characterChosen'; characterIdx: number }
  | { kind: 'trackChosen'; trackId: string }
  | { kind: 'settingsChanged'; settings: Settings }
  | { kind: 'raceStarting' }
  | { kind: 'raceTick'; phase: RacePhase; finishedOrder: readonly number[] }
  | { kind: 'raceFinished'; results: ResultRow[] }
  | { kind: 'serverLostDuringRace' }
  | { kind: 'serverStartReceived' }
  | { kind: 'backToLobby' }
  | { kind: 'quitToTitle' }

/** The single definition of which events are legal on each screen. */
export const SCREEN_TRANSITIONS: Readonly<Record<ScreenId, readonly AppEvent['kind'][]>> = {
  title: [
    'hostPressed', 'joinPressed', 'soloPressed', 'roomCodeEntered',
    'connected', 'connectFailed', 'settingsChanged',
  ],
  characterSelect: [
    'characterChosen', 'lobbyUpdated', 'connectFailed',
    'settingsChanged', 'quitToTitle',
  ],
  lobby: [
    'lobbyUpdated', 'characterChosen', 'trackChosen', 'raceStarting',
    'connectFailed', 'settingsChanged', 'quitToTitle',
  ],
  race: [
    'raceTick', 'raceFinished', 'serverLostDuringRace', 'serverStartReceived',
    'lobbyUpdated', 'connectFailed',
    'settingsChanged', 'quitToTitle',
  ],
  results: [
    'serverLostDuringRace', 'serverStartReceived', 'backToLobby', 'lobbyUpdated', 'connectFailed',
    'settingsChanged', 'quitToTitle',
  ],
}

const ROOM_CODE_ERROR = 'Enter a ' + ROOM_CODE_LENGTH + '-character room code.'

function isKnownTrack(trackId: string): boolean {
  for (const entry of TRACK_MANIFEST) {
    if (entry.id === trackId) return true
  }
  return false
}

export function canRequestStart(state: AppState): boolean {
  return state.screen === 'lobby' && state.role !== 'guest'
}

export function canChooseTrack(state: AppState): boolean {
  return state.screen === 'lobby' && state.role !== 'guest'
}

/** NFC/App-Link invites are accepted only while the player is choosing how to
 * enter a game. A host or an in-flight join must never be silently replaced. */
export function canAcceptInvite(state: AppState): boolean {
  return state.screen === 'title' && !state.connecting && state.role !== 'host'
}

function emptySlot(): LobbySlot {
  return {
    playerId: -1,
    name: '',
    characterIdx: 0,
    isBot: false,
    connected: false,
    ready: false,
  }
}

function copySlots(src: readonly LobbySlot[]): LobbySlot[] {
  const out: LobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    if (i >= src.length) {
      out.push(emptySlot())
      continue
    }
    const slot = src[i]
    out.push({
      playerId: slot.playerId,
      name: slot.name,
      characterIdx: slot.characterIdx,
      isBot: slot.isBot,
      connected: slot.connected,
      ready: slot.ready,
    })
  }
  return out
}

export function createAppState(settings: Settings): AppState {
  const slots: LobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) slots.push(emptySlot())
  return {
    screen: 'title',
    role: 'solo',
    roomCode: '',
    trackId: settings.lastTrackId,
    localPlayerId: -1,
    slots,
    settings,
    results: [],
    error: '',
    connecting: false,
    serverLost: false,
  }
}

/** Pure and total. Illegal events and invalid content references are identity
 * no-ops, and no branch mutates the previous state. */
export function reduceApp(prev: AppState, ev: AppEvent): AppState {
  if (!SCREEN_TRANSITIONS[prev.screen].includes(ev.kind)) return prev

  switch (ev.kind) {
    case 'hostPressed':
      return { ...prev, role: 'host', roomCode: '', connecting: true, error: '' }

    case 'joinPressed':
      return { ...prev, role: 'guest', roomCode: '', connecting: false, error: '' }

    case 'soloPressed':
      return {
        ...prev,
        screen: 'characterSelect',
        role: 'solo',
        roomCode: '',
        localPlayerId: 0,
        connecting: false,
        error: '',
        serverLost: false,
      }

    case 'roomCodeEntered': {
      const code = normalizeRoomCode(ev.code)
      if (!isValidRoomCode(code)) {
        return { ...prev, roomCode: code, connecting: false, error: ROOM_CODE_ERROR }
      }
      return { ...prev, roomCode: code, connecting: true, error: '' }
    }

    case 'connected':
      return {
        ...prev,
        screen: 'characterSelect',
        role: ev.role,
        roomCode: ev.roomCode,
        localPlayerId: ev.localPlayerId,
        connecting: false,
        error: '',
        serverLost: false,
      }

    case 'connectFailed': {
      const next = createAppState(prev.settings)
      next.error = ev.message
      return next
    }

    case 'lobbyUpdated':
      return {
        ...prev,
        slots: copySlots(ev.slots),
        trackId: isKnownTrack(ev.trackId) ? ev.trackId : prev.trackId,
      }

    case 'characterChosen': {
      if (!Number.isInteger(ev.characterIdx)) return prev
      if (ev.characterIdx < 0 || ev.characterIdx >= CHARACTERS.length) return prev
      const settings: Settings = { ...prev.settings, characterIdx: ev.characterIdx }
      return {
        ...prev,
        settings,
        screen: prev.screen === 'characterSelect' ? 'lobby' : prev.screen,
      }
    }

    case 'trackChosen': {
      if (!canChooseTrack(prev)) return prev
      if (!isKnownTrack(ev.trackId)) return prev
      return {
        ...prev,
        trackId: ev.trackId,
        settings: { ...prev.settings, lastTrackId: ev.trackId },
      }
    }

    case 'settingsChanged':
      return { ...prev, settings: ev.settings }

    case 'raceStarting':
      return { ...prev, screen: 'race', results: [], error: '', serverLost: false }

    case 'raceTick':
      return prev

    case 'raceFinished':
      return { ...prev, screen: 'results', results: ev.results.slice() }

    case 'serverLostDuringRace':
      return { ...prev, serverLost: true, error: SERVER_LOST_RACE_WARNING }

    case 'serverStartReceived':
      return { ...prev, screen: 'lobby', results: [], error: '', serverLost: false }

    case 'backToLobby':
      return { ...prev, screen: 'lobby', results: [], error: '', serverLost: false }

    case 'quitToTitle':
      return createAppState(prev.settings)
  }
}
