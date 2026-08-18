import { describe, expect, it } from 'vitest'
import { MAX_KARTS } from '@tapkart/sim'
import { CHARACTERS, TRACK_MANIFEST } from '@tapkart/content'
import { ROOM_CODE_LENGTH, normalizeRoomCode } from '@tapkart/protocol'
import type { AppEvent, AppState, ScreenId } from '../src/app'
import {
  SCREEN_TRANSITIONS,
  SERVER_LOST_RACE_WARNING,
  SERVER_LOST_RECOVERY_MESSAGE,
  canAcceptInvite,
  canChooseTrack,
  canRequestStart,
  createAppState,
  reduceApp,
} from '../src/app'
import { makeLobbySlots, makeSettingsFixture } from './fixtures/game-fixtures'

const screens: ScreenId[] = ['title', 'characterSelect', 'lobby', 'race', 'results']
const kinds: AppEvent['kind'][] = [
  'hostPressed', 'joinPressed', 'soloPressed', 'roomCodeEntered', 'connected',
  'connectFailed', 'lobbyUpdated', 'characterChosen', 'trackChosen',
  'settingsChanged', 'raceStarting', 'raceTick', 'raceFinished',
  'serverLostDuringRace', 'serverStartReceived', 'backToLobby', 'quitToTitle',
]

function stateOn(screen: ScreenId): AppState {
  return {
    ...createAppState(makeSettingsFixture()),
    screen,
    role: screen === 'title' ? 'solo' : 'host',
    roomCode: screen === 'title' ? '' : 'AB23C',
    localPlayerId: screen === 'title' ? -1 : 1,
    slots: makeLobbySlots([0, 1]),
  }
}

function event(kind: AppEvent['kind']): AppEvent {
  switch (kind) {
    case 'hostPressed': return { kind }
    case 'joinPressed': return { kind }
    case 'soloPressed': return { kind }
    case 'roomCodeEntered': return { kind, code: '7K2MQ' }
    case 'connected': return { kind, roomCode: '7K2MQ', localPlayerId: 2, role: 'guest' }
    case 'connectFailed': return { kind, message: 'lost' }
    case 'lobbyUpdated': return { kind, slots: makeLobbySlots([0, 2]), trackId: TRACK_MANIFEST[1].id }
    case 'characterChosen': return { kind, characterIdx: 3 }
    case 'trackChosen': return { kind, trackId: TRACK_MANIFEST[1].id }
    case 'settingsChanged': return { kind, settings: makeSettingsFixture({ audioVolume: 0.3 }) }
    case 'raceStarting': return { kind }
    case 'raceTick': return { kind, phase: 'racing', finishedOrder: [] }
    case 'raceFinished': return { kind, results: [{ place: 1, playerId: 2, name: 'P2', dnf: false }] }
    case 'serverLostDuringRace': return { kind }
    case 'serverStartReceived': return { kind }
    case 'backToLobby': return { kind }
    case 'quitToTitle': return { kind }
  }
}

describe('app state machine', () => {
  it('creates the canonical title state and eight distinct empty slots', () => {
    const s = createAppState(makeSettingsFixture({ lastTrackId: TRACK_MANIFEST[2].id }))
    expect(s).toMatchObject({
      screen: 'title', role: 'solo', roomCode: '', localPlayerId: -1,
      trackId: TRACK_MANIFEST[2].id, results: [], error: '', connecting: false,
      serverLost: false,
    })
    expect(s.slots).toHaveLength(MAX_KARTS)
    expect(s.slots.every((slot) => slot.playerId === -1 && !slot.connected)).toBe(true)
    expect(s.slots[0]).not.toBe(s.slots[1])
  })

  it('makes the transition table exhaustive, unique, and the sole legality rule', () => {
    expect(Object.keys(SCREEN_TRANSITIONS).sort()).toEqual([...screens].sort())
    for (const kind of kinds) {
      expect(screens.some((screen) => SCREEN_TRANSITIONS[screen].includes(kind))).toBe(true)
    }
    for (const screen of screens) {
      expect(new Set(SCREEN_TRANSITIONS[screen]).size).toBe(SCREEN_TRANSITIONS[screen].length)
      for (const kind of kinds) {
        if (SCREEN_TRANSITIONS[screen].includes(kind)) continue
        const prev = stateOn(screen)
        expect(reduceApp(prev, event(kind))).toBe(prev)
      }
    }
  })

  it('walks the solo flow without network state', () => {
    let s = createAppState(makeSettingsFixture())
    s = reduceApp(s, { kind: 'soloPressed' })
    expect(s).toMatchObject({ screen: 'characterSelect', role: 'solo', localPlayerId: 0, roomCode: '' })
    s = reduceApp(s, { kind: 'characterChosen', characterIdx: 1 })
    expect(s.screen).toBe('lobby')
    s = reduceApp(s, { kind: 'raceStarting' })
    expect(s.screen).toBe('race')
  })

  it('normalizes valid room codes and reports invalid ones without connecting', () => {
    const valid = reduceApp(stateOn('title'), { kind: 'roomCodeEntered', code: '7k2mq' })
    expect(valid.roomCode).toBe(normalizeRoomCode('7k2mq'))
    expect(valid.connecting).toBe(true)
    const invalid = reduceApp(stateOn('title'), { kind: 'roomCodeEntered', code: '7K2' })
    expect(invalid.connecting).toBe(false)
    expect(invalid.error).toBe('Enter a ' + ROOM_CODE_LENGTH + '-character room code.')
  })

  it('takes the multiplayer role from the successful server handshake', () => {
    const guessedGuest = reduceApp(createAppState(makeSettingsFixture()), { kind: 'joinPressed' })
    const reclaimedHost = reduceApp(guessedGuest, {
      kind: 'connected',
      roomCode: '7K2MQ',
      localPlayerId: 0,
      role: 'host',
    })

    expect(reclaimedHost).toMatchObject({
      screen: 'characterSelect',
      role: 'host',
      localPlayerId: 0,
    })
  })

  it('validates content choices and never mutates the previous settings', () => {
    const prev = stateOn('lobby')
    const next = reduceApp(prev, { kind: 'characterChosen', characterIdx: 7 })
    expect(next.settings.characterIdx).toBe(7)
    expect(next.settings).not.toBe(prev.settings)
    for (const bad of [-1, CHARACTERS.length, 1.5, Number.NaN]) {
      expect(reduceApp(prev, { kind: 'characterChosen', characterIdx: bad })).toBe(prev)
    }
    const track = reduceApp(prev, { kind: 'trackChosen', trackId: TRACK_MANIFEST[2].id })
    expect(track.trackId).toBe(TRACK_MANIFEST[2].id)
    expect(track.settings.lastTrackId).toBe(TRACK_MANIFEST[2].id)
    expect(track.settings).not.toBe(prev.settings)
    expect(prev.settings.lastTrackId).not.toBe(TRACK_MANIFEST[2].id)
    expect(reduceApp(prev, { kind: 'trackChosen', trackId: 'atlantis' })).toBe(prev)
  })

  it('copies and pads lobby updates to MAX_KARTS', () => {
    const incoming = makeLobbySlots([0, 1]).slice(0, 3)
    const next = reduceApp(stateOn('lobby'), {
      kind: 'lobbyUpdated',
      slots: incoming,
      trackId: TRACK_MANIFEST[1].id,
    })
    expect(next.slots).toHaveLength(MAX_KARTS)
    expect(next.slots[3].playerId).toBe(-1)
    incoming[0].name = 'mutated'
    expect(next.slots[0].name).toBe('Player 0')
  })

  it('takes multiplayer track truth from the server lobby', () => {
    const prev = { ...stateOn('lobby'), role: 'guest' as const, trackId: TRACK_MANIFEST[0].id }
    const next = reduceApp(prev, {
      kind: 'lobbyUpdated',
      slots: prev.slots,
      trackId: TRACK_MANIFEST[2].id,
    })
    expect(next.trackId).toBe(TRACK_MANIFEST[2].id)
    expect(reduceApp(next, {
      kind: 'lobbyUpdated',
      slots: next.slots,
      trackId: 'not-a-track',
    }).trackId).toBe(TRACK_MANIFEST[2].id)
  })

  it('lets only host and solo request start or choose a track', () => {
    const host = { ...stateOn('lobby'), role: 'host' as const }
    const solo = { ...stateOn('lobby'), role: 'solo' as const }
    const guest = { ...stateOn('lobby'), role: 'guest' as const }
    expect(canRequestStart(host)).toBe(true)
    expect(canRequestStart(solo)).toBe(true)
    expect(canRequestStart(guest)).toBe(false)
    expect(canChooseTrack(host)).toBe(true)
    expect(canChooseTrack(solo)).toBe(true)
    expect(canChooseTrack(guest)).toBe(false)
    expect(reduceApp(guest, { kind: 'trackChosen', trackId: TRACK_MANIFEST[1].id })).toBe(guest)
  })

  it('accepts an invite only from an idle title or manual join screen', () => {
    const title = createAppState(makeSettingsFixture())
    expect(canAcceptInvite(title)).toBe(true)
    expect(canAcceptInvite(reduceApp(title, { kind: 'joinPressed' }))).toBe(true)
    expect(canAcceptInvite(reduceApp(title, { kind: 'hostPressed' }))).toBe(false)
    expect(canAcceptInvite({ ...title, connecting: true })).toBe(false)
    for (const screen of ['characterSelect', 'lobby', 'race', 'results'] as const) {
      expect(canAcceptInvite(stateOn(screen))).toBe(false)
    }
  })

  it('keeps raceTick state-free and copies result rows', () => {
    const prev = stateOn('race')
    expect(reduceApp(prev, { kind: 'raceTick', phase: 'finished', finishedOrder: [1, 0] })).toBe(prev)
    const rows = [{ place: 1, playerId: 1, name: 'P1', dnf: false }]
    const next = reduceApp(prev, { kind: 'raceFinished', results: rows })
    expect(next.screen).toBe('results')
    rows.push({ place: 2, playerId: 0, name: 'P0', dnf: true })
    expect(next.results).toHaveLength(1)
  })

  it('routes an old race or results screen through lobby before a rematch', () => {
    for (const screen of ['race', 'results'] as const) {
      const oldRace = {
        ...stateOn(screen),
        results: [{ place: 1, playerId: 0, name: 'Host', dnf: false }],
      }
      const lobby = reduceApp(oldRace, { kind: 'serverStartReceived' })
      const race = reduceApp(lobby, { kind: 'raceStarting' })

      expect(lobby).toMatchObject({ screen: 'lobby', results: [] })
      expect(race).toMatchObject({ screen: 'race', results: [] })
    }
  })

  it('keeps direct play/results visible after server loss, then recovers to title', () => {
    const racing = { ...stateOn('race'), role: 'guest' as const }
    const degraded = reduceApp(racing, { kind: 'serverLostDuringRace' })
    expect(degraded).toMatchObject({
      screen: 'race',
      serverLost: true,
      error: SERVER_LOST_RACE_WARNING,
    })

    const results = reduceApp(degraded, {
      kind: 'raceFinished',
      results: [{ place: 1, playerId: 1, name: 'Guest', dnf: false }],
    })
    expect(results).toMatchObject({
      screen: 'results',
      serverLost: true,
      error: SERVER_LOST_RACE_WARNING,
    })

    const recovered = reduceApp(results, {
      kind: 'connectFailed',
      message: SERVER_LOST_RECOVERY_MESSAGE,
    })
    expect(recovered).toMatchObject({
      screen: 'title',
      roomCode: '',
      serverLost: false,
      error: SERVER_LOST_RECOVERY_MESSAGE,
    })
  })

  it('resets connection state on failure from every screen but preserves settings', () => {
    for (const screen of screens) {
      const prev = stateOn(screen)
      const next = reduceApp(prev, { kind: 'connectFailed', message: 'host went away' })
      expect(next).toMatchObject({
        screen: 'title', roomCode: '', localPlayerId: -1,
        error: 'host went away', connecting: false,
      })
      expect(next.settings).toBe(prev.settings)
    }
  })
})
