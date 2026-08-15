import type { RacePhase } from '@tapkart/sim'
import { MAX_KARTS } from '@tapkart/sim'
import type { ViewRole } from '@tapkart/render'
import { CHARACTERS, TRACK_MANIFEST } from '@tapkart/content'
import { ROOM_CODE_LENGTH, isValidRoomCode, normalizeRoomCode } from '@tapkart/protocol'
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
}

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
    'raceTick', 'raceFinished', 'lobbyUpdated', 'connectFailed',
    'settingsChanged', 'quitToTitle',
  ],
  results: [
    'backToLobby', 'lobbyUpdated', 'connectFailed',
    'settingsChanged', 'quitToTitle',
  ],
}

const ROOM_CODE_ERROR = 'Enter a ' + ROOM_CODE_LENGTH + '-character room code.'

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
        roomCode: ev.roomCode,
        localPlayerId: ev.localPlayerId,
        connecting: false,
        error: '',
      }

    case 'connectFailed': {
      const next = createAppState(prev.settings)
      next.error = ev.message
      return next
    }

    case 'lobbyUpdated':
      return { ...prev, slots: copySlots(ev.slots) }

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
      let known = false
      for (const entry of TRACK_MANIFEST) {
        if (entry.id === ev.trackId) {
          known = true
          break
        }
      }
      return known ? { ...prev, trackId: ev.trackId } : prev
    }

    case 'settingsChanged':
      return { ...prev, settings: ev.settings }

    case 'raceStarting':
      return { ...prev, screen: 'race', results: [], error: '' }

    case 'raceTick':
      return prev

    case 'raceFinished':
      return { ...prev, screen: 'results', results: ev.results.slice() }

    case 'backToLobby':
      return { ...prev, screen: 'lobby', results: [], error: '' }

    case 'quitToTitle':
      return createAppState(prev.settings)
  }
}
