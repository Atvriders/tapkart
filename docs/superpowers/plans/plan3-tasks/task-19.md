### Task 19: `packages/game/src/app.ts` — the screen state machine, pure

**Files:**
- Create: `packages/game/src/app.ts`
- Modify: `packages/game/test/fixtures/game-fixtures.ts` (append `makeLobbySlots`; do not rewrite the file)
- Test: `packages/game/test/app.test.ts`

Do **not** touch `packages/game/src/index.ts` (the barrel task owns it, contract §5.15) and do **not**
create `packages/game/src/results.ts` — that is **the very next task**, and a stub here would make
`ResultRow` a type with two definitions, which is the defect class this plan is written to avoid.

**Interfaces:**

- Consumes, from `@tapkart/sim` (contract §2.1):
  ```ts
  export const MAX_KARTS = 8
  export type RacePhase = 'countdown' | 'racing' | 'finished'
  ```
- Consumes, from `@tapkart/render` (contract §4.2) — **type only**:
  ```ts
  /** The session's role, named once, in the lowest package that needs it. `game`
   *  imports this type rather than declaring a second union. There is no `SessionRole`. */
  export type ViewRole = 'host' | 'guest' | 'solo'
  ```
- Consumes, from `@tapkart/content` (contract §3a.2, §3a.5):
  ```ts
  export interface TrackManifestEntry { id: string; name: string }
  export const TRACK_MANIFEST: readonly TrackManifestEntry[]   // six ids, ascending
  export const CHARACTERS: readonly CharacterStats[]           // length 8
  ```
- Consumes, from Task 18:
  ```ts
  export interface Settings {
    scheme: ControlScheme; tiltCalibration: TiltCalibration; invertTilt: boolean
    audioEnabled: boolean; audioVolume: number; characterIdx: number
    lastTrackId: string; playerName: string
  }
  ```
- Consumes, from `@tapkart/protocol` (shipped `packages/protocol/src/room.ts`, which
  **retires** contract §5.8's `game/src/roomcode.ts` — the code is 5 characters, the
  alphabet is Crockford, and the alphabet's ORDER is the 5-bit wire index):
  ```ts
  export const ROOM_CODE_LENGTH = 5
  export function normalizeRoomCode(raw: string): string   // no longer strips or truncates
  export function isValidRoomCode(raw: string): boolean
  ```
  and `packages/game/test/fixtures/game-fixtures.ts`, which already exports
  `makeControlInputsFixture` and `makeSettingsFixture(overrides?: Partial<Settings>): Settings`.
- Consumes, from the **next** task (contract §5.12) — **type only**, and see the forward-reference note below:
  ```ts
  export interface ResultRow { place: number; playerId: number; name: string; dnf: boolean }
  ```
- Produces (contract §5.9 — 7 exported symbols, exactly the census in §11):
  ```ts
  export type ScreenId = 'title' | 'characterSelect' | 'lobby' | 'race' | 'results'
  export interface LobbySlot {
    playerId: number; name: string; characterIdx: number
    isBot: boolean; connected: boolean; ready: boolean
  }
  export interface AppState {
    screen: ScreenId; role: ViewRole; roomCode: string; trackId: string
    localPlayerId: number; slots: LobbySlot[]; settings: Settings
    results: ResultRow[]; error: string; connecting: boolean
  }
  export function createAppState(settings: Settings): AppState
  export type AppEvent =
    | { kind: 'hostPressed' } | { kind: 'joinPressed' } | { kind: 'soloPressed' }
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
    | { kind: 'backToLobby' } | { kind: 'quitToTitle' }
  export function reduceApp(prev: AppState, ev: AppEvent): AppState
  export const SCREEN_TRANSITIONS: Readonly<Record<ScreenId, readonly AppEvent['kind'][]>>
  ```
  ```ts
  // test/fixtures/game-fixtures.ts — appended (contract §9.1)
  export function makeLobbySlots(humanIds?: readonly number[]): LobbySlot[]
  ```

**The forward reference to `results.ts`.** `AppState.results` is `ResultRow[]`, and `ResultRow` lives
in `src/results.ts` (contract §5.12), which is **the next task in this plan**. It sits after this one
rather than before it because the two modules import each other type-only — `results.ts` needs
`LobbySlot` from here — so putting it first would invert this error rather than remove it. The import
here is `import type`, which `verbatimModuleSyntax` erases, so **vitest runs green either way**.
`tsc --noEmit` will report exactly one error, and only until the next task lands:
`src/app.ts(N,M): error TS2307: Cannot find module './results' or its corresponding type declarations.`
That single error is expected and is the correct state of the tree; do not silence it with a stub, a
local re-declaration, or `any`.

**Five screens, and the two things that are deliberately not screens (Q14).**

- **Countdown is not a screen.** `sim` already models it as `phase === 'countdown'`; giving it a
  screen would put one fact in two places, which is the defect class this project keeps paying for.
  The race screen renders the countdown overlay when the view says so.
- **`join/host` is not a screen.** It is the title screen's three buttons (`hostPressed`,
  `joinPressed`, `soloPressed`), with `connecting` and `error` carrying the modal. A screen with two
  buttons and no state of its own is a control, not a screen.
- Consequently **`raceTick` changes nothing.** It is legal on `'race'` and returns `prev` **by
  reference**: `AppState` holds no `phase` and no `finishedOrder`, because the `RaceView` is the
  single source of truth for both. The test below pins that, so a future "just cache the phase here"
  edit fails loudly rather than creating the second copy.

- [ ] **Step 1: Write the failing test**

Append to `packages/game/test/fixtures/game-fixtures.ts` (Tasks 17 and 18 created and extended this
file; keep both existing exports):

```ts
import { CHARACTERS } from '@tapkart/content'
import { MAX_KARTS } from '@tapkart/sim'
import type { LobbySlot } from '../../src/app'

/** MAX_KARTS filled slots. Seats in `humanIds` are connected humans; every other
 *  seat is a bot. Defaults to seat 0 being the only human, which is solo. */
export function makeLobbySlots(humanIds: readonly number[] = [0]): LobbySlot[] {
  const slots: LobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const human = humanIds.includes(i)
    slots.push({
      playerId: i,
      name: human ? `Player ${i}` : `Bot ${i}`,
      characterIdx: i % CHARACTERS.length,
      isBot: !human,
      connected: true,
      ready: true,
    })
  }
  return slots
}
```

Create `packages/game/test/app.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MAX_KARTS } from '@tapkart/sim'
import { CHARACTERS, TRACK_MANIFEST } from '@tapkart/content'
// Room codes are protocol's. This file asserts that the reducer DELEGATES to
// them, never what they do: the length, the alphabet and its wire-index order
// belong to one module, and a hard-coded expectation here would be a second copy.
import { ROOM_CODE_LENGTH, isValidRoomCode, normalizeRoomCode } from '@tapkart/protocol'
import type { AppEvent, AppState, ScreenId } from '../src/app'
import { SCREEN_TRANSITIONS, createAppState, reduceApp } from '../src/app'
import { makeLobbySlots, makeSettingsFixture } from './fixtures/game-fixtures'

// Compile-time exhaustive over AppEvent['kind']: adding an event without adding it
// here is a type error, so "no event is dead" below cannot silently stop covering
// the new one.
const KIND_TABLE: Record<AppEvent['kind'], true> = {
  hostPressed: true,
  joinPressed: true,
  soloPressed: true,
  roomCodeEntered: true,
  connected: true,
  connectFailed: true,
  lobbyUpdated: true,
  characterChosen: true,
  trackChosen: true,
  settingsChanged: true,
  raceStarting: true,
  raceTick: true,
  raceFinished: true,
  backToLobby: true,
  quitToTitle: true,
}
const ALL_KINDS = Object.keys(KIND_TABLE) as AppEvent['kind'][]
const ALL_SCREENS: ScreenId[] = ['title', 'characterSelect', 'lobby', 'race', 'results']

/** A LEGAL sample event per kind: every payload is valid, so a rejection below is
 *  the reducer's doing and not the fixture's. */
function sampleEvent(kind: AppEvent['kind']): AppEvent {
  switch (kind) {
    case 'hostPressed': return { kind }
    case 'joinPressed': return { kind }
    case 'soloPressed': return { kind }
    case 'roomCodeEntered': return { kind, code: '7K2MQ' }
    case 'connected': return { kind, roomCode: '7K2MQ', localPlayerId: 2 }
    case 'connectFailed': return { kind, message: 'host went away' }
    case 'lobbyUpdated': return { kind, slots: makeLobbySlots([0, 2]) }
    case 'characterChosen': return { kind, characterIdx: 3 }
    case 'trackChosen': return { kind, trackId: TRACK_MANIFEST[1].id }
    case 'settingsChanged': return { kind, settings: makeSettingsFixture({ playerName: 'Rae', audioVolume: 0.3 }) }
    case 'raceStarting': return { kind }
    case 'raceTick': return { kind, phase: 'racing', finishedOrder: [] }
    case 'raceFinished': return {
      kind,
      results: [{ place: 1, playerId: 2, name: 'Player 2', dnf: false }],
    }
    case 'backToLobby': return { kind }
    case 'quitToTitle': return { kind }
  }
}

/** A populated state parked on `screen`, so a no-op is distinguishable from a
 *  change on every field the reducer touches. */
function stateOn(screen: ScreenId): AppState {
  const base = createAppState(makeSettingsFixture())
  return {
    ...base,
    screen,
    role: screen === 'title' ? 'solo' : 'host',
    roomCode: screen === 'title' ? '' : 'AB23C',
    localPlayerId: screen === 'title' ? -1 : 1,
    slots: makeLobbySlots([0, 1]),
  }
}

function snapshot(s: AppState): string {
  return JSON.stringify(s)
}

/** (screen, kind) pairs that are legal AND deliberately state-free. Exactly one
 *  exists, and it is Q14's countdown ruling in executable form. */
const STATE_FREE: [ScreenId, AppEvent['kind']][] = [['race', 'raceTick']]

function isStateFree(screen: ScreenId, kind: AppEvent['kind']): boolean {
  return STATE_FREE.some((p) => p[0] === screen && p[1] === kind)
}

describe('createAppState', () => {
  it('starts on the title screen with an empty room and no local seat', () => {
    const s = createAppState(makeSettingsFixture({ lastTrackId: TRACK_MANIFEST[2].id }))
    expect(s.screen).toBe('title')
    expect(s.role).toBe('solo')
    expect(s.roomCode).toBe('')
    expect(s.localPlayerId).toBe(-1)
    expect(s.results).toEqual([])
    expect(s.error).toBe('')
    expect(s.connecting).toBe(false)
  })

  it('takes the starting track from the settings, not a literal', () => {
    // CATCHES a hard-coded first track: the player's last choice is persisted for
    // exactly this reason, and a literal here throws it away every launch.
    const s = createAppState(makeSettingsFixture({ lastTrackId: TRACK_MANIFEST[3].id }))
    expect(s.trackId).toBe(TRACK_MANIFEST[3].id)
  })

  it('allocates MAX_KARTS empty slots', () => {
    // CATCHES `slots: []`. Every screen and the HUD index slots by seat; an empty
    // array reads `undefined` for seat 3 and crashes on `.name`.
    const s = createAppState(makeSettingsFixture())
    expect(s.slots).toHaveLength(MAX_KARTS)
    for (const slot of s.slots) {
      expect(slot.playerId).toBe(-1)
      expect(slot.connected).toBe(false)
    }
    expect(s.slots[0]).not.toBe(s.slots[1])
  })
})

describe('SCREEN_TRANSITIONS', () => {
  it('covers all five screens and lists no unknown event kind', () => {
    expect(Object.keys(SCREEN_TRANSITIONS).sort()).toEqual([...ALL_SCREENS].sort())
    for (const screen of ALL_SCREENS) {
      for (const kind of SCREEN_TRANSITIONS[screen]) {
        expect(ALL_KINDS, `${screen} lists an unknown kind: ${kind}`).toContain(kind)
      }
      expect(new Set(SCREEN_TRANSITIONS[screen]).size).toBe(SCREEN_TRANSITIONS[screen].length)
    }
  })

  it('leaves no event dead: every kind is legal on at least one screen', () => {
    // CATCHES an event the union declares and the machine can never process -
    // which compiles, ships, and fails as "the button does nothing".
    for (const kind of ALL_KINDS) {
      const screens = ALL_SCREENS.filter((s) => SCREEN_TRANSITIONS[s].includes(kind))
      expect(screens.length, `${kind} is legal on no screen`).toBeGreaterThan(0)
    }
  })
})

describe('reduceApp - the table IS the legality rule', () => {
  it('returns prev BY REFERENCE for every pair the table does not list', () => {
    // 5 screens x 15 kinds, minus the legal pairs. Reference equality, not deep
    // equality: an identity no-op that allocates a copy defeats every downstream
    // `if (next !== prev) rerender` and repaints the whole UI on every stray event.
    for (const screen of ALL_SCREENS) {
      for (const kind of ALL_KINDS) {
        if (SCREEN_TRANSITIONS[screen].includes(kind)) continue
        const prev = stateOn(screen)
        const next = reduceApp(prev, sampleEvent(kind))
        expect(next, `${screen} + ${kind} must be an identity no-op`).toBe(prev)
      }
    }
  })

  it('produces a new state for every legal pair except the one state-free pair', () => {
    for (const screen of ALL_SCREENS) {
      for (const kind of SCREEN_TRANSITIONS[screen]) {
        const prev = stateOn(screen)
        const next = reduceApp(prev, sampleEvent(kind))
        if (isStateFree(screen, kind)) {
          expect(next, `${screen} + ${kind} is state-free`).toBe(prev)
        } else {
          expect(next, `${screen} + ${kind} is listed but unhandled`).not.toBe(prev)
        }
      }
    }
  })

  it('never mutates prev, on any pair, legal or not', () => {
    // CATCHES in-place edits of the nested slots and settings objects, which pass
    // every "next.x === y" assertion and corrupt the caller's previous state.
    for (const screen of ALL_SCREENS) {
      for (const kind of ALL_KINDS) {
        const prev = stateOn(screen)
        const before = snapshot(prev)
        reduceApp(prev, sampleEvent(kind))
        expect(snapshot(prev), `${screen} + ${kind} mutated prev`).toBe(before)
      }
    }
  })
})

describe('title screen', () => {
  it('hostPressed and joinPressed set the role without leaving the screen', () => {
    const host = reduceApp(stateOn('title'), { kind: 'hostPressed' })
    expect(host.screen).toBe('title')
    expect(host.role).toBe('host')
    expect(host.connecting).toBe(true)

    const join = reduceApp(stateOn('title'), { kind: 'joinPressed' })
    expect(join.screen).toBe('title')
    expect(join.role).toBe('guest')
    expect(join.connecting).toBe(false) // nothing to connect to until a code is typed
  })

  it('soloPressed skips the network entirely and seats the player at 0', () => {
    // CATCHES localPlayerId left at -1 in solo. SessionOptions forbids -1 (§5.10),
    // so the solo race would fail to construct at the composition root.
    const s = reduceApp(stateOn('title'), { kind: 'soloPressed' })
    expect(s.screen).toBe('characterSelect')
    expect(s.role).toBe('solo')
    expect(s.roomCode).toBe('')
    expect(s.localPlayerId).toBe(0)
    expect(s.connecting).toBe(false)
  })

  it('normalises a typed room code and starts connecting', () => {
    const typed = '7k2mq'
    const s = reduceApp(stateOn('title'), { kind: 'roomCodeEntered', code: typed })
    // Asserted BY DELEGATION: whatever protocol's normaliser does, the reducer
    // must do exactly that and nothing of its own. A literal expectation here
    // would be a second copy of rules whose alphabet order is a wire format.
    expect(s.roomCode).toBe(normalizeRoomCode(typed))
    expect(isValidRoomCode(s.roomCode)).toBe(true)
    expect(s.connecting).toBe(true)
    expect(s.error).toBe('')
    expect(s.screen).toBe('title')
  })

  it('rejects a short code with a message instead of connecting', () => {
    // CATCHES a reducer that connects on anything typed. The server would answer
    // "no such room" a second later, which reads to the player as a broken game
    // rather than a typo.
    const short = '7K2'
    expect(isValidRoomCode(short)).toBe(false)   // vacuity guard on the fixture
    const s = reduceApp(stateOn('title'), { kind: 'roomCodeEntered', code: short })
    expect(s.connecting).toBe(false)
    expect(s.error).toBe(`Enter a ${ROOM_CODE_LENGTH}-character room code.`)
    expect(s.screen).toBe('title')
  })

  it('connected keeps the minted code verbatim and moves to character select', () => {
    // The server MINTS codes (spec §5, step 1); `game` normalises what a PLAYER types and
    // displays what it is given. Re-normalising an authoritative code would
    // silently rewrite it.
    const s = reduceApp(stateOn('title'), { kind: 'connected', roomCode: '7K2MQ', localPlayerId: 4 })
    expect(s.screen).toBe('characterSelect')
    expect(s.roomCode).toBe('7K2MQ')
    expect(s.localPlayerId).toBe(4)
    expect(s.connecting).toBe(false)
    expect(s.error).toBe('')
  })
})

describe('character select and lobby', () => {
  it('choosing a character advances to the lobby and persists the choice', () => {
    const s = reduceApp(stateOn('characterSelect'), { kind: 'characterChosen', characterIdx: 5 })
    expect(s.screen).toBe('lobby')
    expect(s.settings.characterIdx).toBe(5)
  })

  it('choosing again in the lobby updates the choice without leaving the lobby', () => {
    const s = reduceApp(stateOn('lobby'), { kind: 'characterChosen', characterIdx: 6 })
    expect(s.screen).toBe('lobby')
    expect(s.settings.characterIdx).toBe(6)
  })

  it('rejects a character index outside the shipped roster, by reference', () => {
    // CATCHES an unvalidated index reaching `bundle.characters[idx]` in the render
    // path, where it is an undefined descriptor and a crash on the first frame.
    for (const bad of [-1, CHARACTERS.length, 99, 1.5, Number.NaN]) {
      const prev = stateOn('characterSelect')
      expect(reduceApp(prev, { kind: 'characterChosen', characterIdx: bad })).toBe(prev)
    }
  })

  it('accepts a track from the manifest and rejects anything else, by reference', () => {
    // CATCHES an unvalidated track id reaching loadTrack, which THROWS on an
    // unknown id (§3a.5) - a total function turned into a crash by one bad string.
    const ok = reduceApp(stateOn('lobby'), { kind: 'trackChosen', trackId: TRACK_MANIFEST[4].id })
    expect(ok.trackId).toBe(TRACK_MANIFEST[4].id)

    const prev = stateOn('lobby')
    expect(reduceApp(prev, { kind: 'trackChosen', trackId: 'atlantis' })).toBe(prev)
    expect(reduceApp(prev, { kind: 'trackChosen', trackId: '' })).toBe(prev)
  })

  it('lobbyUpdated always leaves exactly MAX_KARTS slots, padding a short roster', () => {
    // CATCHES `slots: ev.slots`, which lets a three-player update shrink the array
    // and makes seat 5 `undefined` for every consumer that indexes by seat.
    const short = makeLobbySlots([0]).slice(0, 3)
    const s = reduceApp(stateOn('lobby'), { kind: 'lobbyUpdated', slots: short })
    expect(s.slots).toHaveLength(MAX_KARTS)
    expect(s.slots[0].name).toBe('Player 0')
    expect(s.slots[3].playerId).toBe(-1)
    expect(s.slots[7].connected).toBe(false)
  })

  it('truncates an over-long roster rather than growing past MAX_KARTS', () => {
    const long = [...makeLobbySlots([0]), ...makeLobbySlots([0])]
    const s = reduceApp(stateOn('lobby'), { kind: 'lobbyUpdated', slots: long })
    expect(s.slots).toHaveLength(MAX_KARTS)
  })

  it('copies each slot, so the sender cannot mutate app state afterwards', () => {
    // CATCHES a shallow array copy that keeps the caller's slot objects. The
    // network layer reuses its decode buffers; aliasing them means the lobby list
    // changes under the screen between frames, with no event.
    const incoming = makeLobbySlots([0, 1])
    const s = reduceApp(stateOn('lobby'), { kind: 'lobbyUpdated', slots: incoming })
    incoming[0].name = 'MUTATED'
    incoming[0].ready = false
    expect(s.slots[0].name).toBe('Player 0')
    expect(s.slots[0].ready).toBe(true)
    expect(s.slots[0]).not.toBe(incoming[0])
  })

  it('raceStarting enters the race and clears the previous results', () => {
    // CATCHES stale results surviving into the next race, where the results screen
    // would show the LAST race's standings for a moment after this one ends.
    const withResults: AppState = {
      ...stateOn('lobby'),
      results: [{ place: 1, playerId: 0, name: 'Player 0', dnf: false }],
    }
    const s = reduceApp(withResults, { kind: 'raceStarting' })
    expect(s.screen).toBe('race')
    expect(s.results).toEqual([])
  })
})

describe('race and results', () => {
  it('raceTick puts nothing into AppState (Q14: one source of truth for phase)', () => {
    // THE Q14 TEST. `sim` owns `phase`; the RaceView carries it to the screen. A
    // cached copy here is a second source of truth for the fact that decides
    // whether the countdown overlay is up, and the two WILL disagree by a tick.
    // Reference equality is what makes "it was cached" detectable at all.
    const prev = stateOn('race')
    for (const phase of ['countdown', 'racing', 'finished'] as const) {
      expect(reduceApp(prev, { kind: 'raceTick', phase, finishedOrder: [3, 1, 0] })).toBe(prev)
    }
    expect(Object.keys(prev)).not.toContain('phase')
  })

  it('raceFinished shows the results screen with a copy of the rows', () => {
    const rows = [
      { place: 1, playerId: 2, name: 'Player 2', dnf: false },
      { place: 2, playerId: 0, name: 'Player 0', dnf: true },
    ]
    const s = reduceApp(stateOn('race'), { kind: 'raceFinished', results: rows })
    expect(s.screen).toBe('results')
    expect(s.results).toEqual(rows)
    rows.push({ place: 3, playerId: 5, name: 'Player 5', dnf: true })
    expect(s.results).toHaveLength(2)
  })

  it('backToLobby returns to the lobby with the room intact and the results cleared', () => {
    // Spec §5 step 7: "Results screen, then back to the lobby with the room
    // intact." CATCHES a rematch that drops the room code or the seat, which would
    // silently make the second race a different session.
    const finished: AppState = {
      ...stateOn('results'),
      results: [{ place: 1, playerId: 1, name: 'Player 1', dnf: false }],
    }
    const s = reduceApp(finished, { kind: 'backToLobby' })
    expect(s.screen).toBe('lobby')
    expect(s.results).toEqual([])
    expect(s.roomCode).toBe('AB23C')
    expect(s.localPlayerId).toBe(1)
    expect(s.slots).toHaveLength(MAX_KARTS)
  })
})

describe('leaving, from anywhere', () => {
  it('connectFailed drops back to the title with the reason and a cleared room', () => {
    // CATCHES a disconnect handled only on the title screen, which strands the
    // player on a lobby or a race whose peers are gone - the screen keeps
    // rendering and nothing ever changes again.
    for (const screen of ALL_SCREENS) {
      const prev = stateOn(screen)
      const s = reduceApp(prev, { kind: 'connectFailed', message: 'host went away' })
      expect(s.screen, `from ${screen}`).toBe('title')
      expect(s.error).toBe('host went away')
      expect(s.roomCode).toBe('')
      expect(s.localPlayerId).toBe(-1)
      expect(s.connecting).toBe(false)
      expect(s.slots[0].playerId).toBe(-1)
      expect(s.settings).toEqual(prev.settings)
    }
  })

  it('quitToTitle resets everything except the settings', () => {
    for (const screen of ['characterSelect', 'lobby', 'race', 'results'] as ScreenId[]) {
      const prev: AppState = {
        ...stateOn(screen),
        results: [{ place: 1, playerId: 1, name: 'Player 1', dnf: false }],
        error: 'stale',
      }
      const s = reduceApp(prev, { kind: 'quitToTitle' })
      expect(s.screen, `from ${screen}`).toBe('title')
      expect(s.roomCode).toBe('')
      expect(s.localPlayerId).toBe(-1)
      expect(s.results).toEqual([])
      expect(s.error).toBe('')
      expect(s.settings).toBe(prev.settings)
    }
  })
})

describe('settings', () => {
  it('settingsChanged replaces the settings on every screen', () => {
    // The settings overlay is reachable from everywhere, so this is legal on all
    // five screens - and it must never disturb the rest of the state.
    for (const screen of ALL_SCREENS) {
      const prev = stateOn(screen)
      const next = makeSettingsFixture({ scheme: 'tilt', audioVolume: 0.1 })
      const s = reduceApp(prev, { kind: 'settingsChanged', settings: next })
      expect(s.settings, `on ${screen}`).toBe(next)
      expect(s.screen).toBe(screen)
      expect(s.roomCode).toBe(prev.roomCode)
      expect(s.slots).toBe(prev.slots)
    }
  })

  it('characterChosen writes a NEW settings object rather than mutating the old one', () => {
    // CATCHES `prev.settings.characterIdx = idx`, which edits the object the
    // previous state, the shell and any pending save all still hold.
    const prev = stateOn('lobby')
    const before = JSON.stringify(prev.settings)
    const s = reduceApp(prev, { kind: 'characterChosen', characterIdx: 7 })
    expect(s.settings).not.toBe(prev.settings)
    expect(JSON.stringify(prev.settings)).toBe(before)
    expect(s.settings.characterIdx).toBe(7)
  })
})

describe('the flow a player actually walks', () => {
  it('title -> character select -> lobby -> race -> results -> lobby', () => {
    let s = createAppState(makeSettingsFixture())
    s = reduceApp(s, { kind: 'joinPressed' })
    s = reduceApp(s, { kind: 'roomCodeEntered', code: '7K2MQ' })
    expect(s.connecting).toBe(true)
    s = reduceApp(s, { kind: 'connected', roomCode: '7K2MQ', localPlayerId: 3 })
    expect(s.screen).toBe('characterSelect')
    s = reduceApp(s, { kind: 'characterChosen', characterIdx: 2 })
    expect(s.screen).toBe('lobby')
    s = reduceApp(s, { kind: 'lobbyUpdated', slots: makeLobbySlots([0, 3]) })
    s = reduceApp(s, { kind: 'trackChosen', trackId: TRACK_MANIFEST[2].id })
    s = reduceApp(s, { kind: 'raceStarting' })
    expect(s.screen).toBe('race')
    s = reduceApp(s, { kind: 'raceTick', phase: 'countdown', finishedOrder: [] })
    s = reduceApp(s, { kind: 'raceTick', phase: 'racing', finishedOrder: [] })
    s = reduceApp(s, { kind: 'raceFinished', results: [{ place: 1, playerId: 3, name: 'Player 3', dnf: false }] })
    expect(s.screen).toBe('results')
    s = reduceApp(s, { kind: 'backToLobby' })
    expect(s.screen).toBe('lobby')
    expect(s.role).toBe('guest')
    expect(s.roomCode).toBe('7K2MQ')
    expect(s.localPlayerId).toBe(3)
    expect(s.trackId).toBe(TRACK_MANIFEST[2].id)
    expect(s.settings.characterIdx).toBe(2)
  })

  it('solo reaches the race without ever touching the network fields', () => {
    let s = createAppState(makeSettingsFixture())
    s = reduceApp(s, { kind: 'soloPressed' })
    s = reduceApp(s, { kind: 'characterChosen', characterIdx: 1 })
    s = reduceApp(s, { kind: 'raceStarting' })
    expect(s.screen).toBe('race')
    expect(s.role).toBe('solo')
    expect(s.roomCode).toBe('')
    expect(s.localPlayerId).toBe(0)
    expect(s.connecting).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/app.test.ts`
Expected: FAIL with `Failed to resolve import "../src/app" from "packages/game/test/app.test.ts". Does the file exist?`

- [ ] **Step 3: Write the implementation**

Create `packages/game/src/app.ts`:

```ts
import type { RacePhase } from '@tapkart/sim'
import { MAX_KARTS } from '@tapkart/sim'
import type { ViewRole } from '@tapkart/render'
import { CHARACTERS, TRACK_MANIFEST } from '@tapkart/content'
// Type-only, and erased by verbatimModuleSyntax. `ResultRow` belongs to the NEXT
// task, and until it lands `tsc` reports one TS2307 here. That is the correct
// state of the tree; a stub would give one type two definitions.
import type { ResultRow } from './results'
import type { Settings } from './settings'
// Room codes are @tapkart/protocol's: there is no game/src/roomcode.ts, because
// the alphabet's ORDER is the 5-bit wire index and a second copy would be a
// second wire format. The code is 5 characters, not 4.
import { ROOM_CODE_LENGTH, isValidRoomCode, normalizeRoomCode } from '@tapkart/protocol'

/** Q14: spec §3's five screens are canonical. Countdown is NOT one of them - `sim`
 *  models it as `phase === 'countdown'` and the race screen reads that from the
 *  view. Neither is join/host: those are the title screen's buttons. */
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
  role: ViewRole // from @tapkart/render; there is no second union
  roomCode: string // '' when solo or not yet minted
  trackId: string
  localPlayerId: number // -1 until connected
  slots: LobbySlot[] // length MAX_KARTS
  settings: Settings
  results: ResultRow[] // [] until the race finishes
  error: string // '' when none
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

/**
 * Every legal (screen, event.kind) pair, as data. Exported so a test proves the
 * table and the reducer agree - and `reduceApp` READS it, so legality has one
 * definition rather than two that drift.
 */
export const SCREEN_TRANSITIONS: Readonly<Record<ScreenId, readonly AppEvent['kind'][]>> = {
  title: ['hostPressed', 'joinPressed', 'soloPressed', 'roomCodeEntered', 'connected',
          'connectFailed', 'settingsChanged'],
  characterSelect: ['characterChosen', 'lobbyUpdated', 'connectFailed', 'settingsChanged',
                    'quitToTitle'],
  lobby: ['lobbyUpdated', 'characterChosen', 'trackChosen', 'raceStarting', 'connectFailed',
          'settingsChanged', 'quitToTitle'],
  race: ['raceTick', 'raceFinished', 'lobbyUpdated', 'connectFailed', 'settingsChanged',
         'quitToTitle'],
  results: ['backToLobby', 'lobbyUpdated', 'connectFailed', 'settingsChanged', 'quitToTitle'],
}

const ROOM_CODE_ERROR = `Enter a ${ROOM_CODE_LENGTH}-character room code.`

function emptySlot(): LobbySlot {
  return { playerId: -1, name: '', characterIdx: 0, isBot: false, connected: false, ready: false }
}

/** Field by field, never by reference: the network layer reuses its decode
 *  buffers, so an aliased slot changes under the screen with no event. */
function copySlots(src: readonly LobbySlot[]): LobbySlot[] {
  const out: LobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    if (i < src.length) {
      const s = src[i]
      out.push({
        playerId: s.playerId,
        name: s.name,
        characterIdx: s.characterIdx,
        isBot: s.isBot,
        connected: s.connected,
        ready: s.ready,
      })
    } else {
      out.push(emptySlot())
    }
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

/**
 * Pure and total: returns a NEW AppState and never mutates `prev`. SOLE WRITER of
 * every AppState field (§7.2). An event not legal for the current screen is an
 * identity no-op returning `prev` BY REFERENCE, never a throw - and so is an event
 * whose payload names something that does not ship (a character past the roster, a
 * track that is not in the manifest), because the alternative is a crash three
 * layers down in `loadTrack` or the descriptor lookup.
 */
export function reduceApp(prev: AppState, ev: AppEvent): AppState {
  if (!SCREEN_TRANSITIONS[prev.screen].includes(ev.kind)) return prev

  switch (ev.kind) {
    case 'hostPressed':
      return { ...prev, role: 'host', roomCode: '', connecting: true, error: '' }

    case 'joinPressed':
      // No connection is attempted until a code is entered, so `connecting` stays
      // false: the title screen shows the code field, not a spinner.
      return { ...prev, role: 'guest', roomCode: '', connecting: false, error: '' }

    case 'soloPressed':
      // Seat 0, immediately: SessionOptions forbids localPlayerId === -1 (§5.10),
      // and solo still runs a real AuthorityLoop over a loopback transport (Q15).
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
      // The code is the SERVER's (spec §5, step 1). `game` normalises what a player
      // types and displays what it is given - re-normalising here would rewrite an
      // authoritative value.
      return {
        ...prev,
        screen: 'characterSelect',
        roomCode: ev.roomCode,
        localPlayerId: ev.localPlayerId,
        connecting: false,
        error: '',
      }

    case 'connectFailed': {
      // Legal on every screen: a connection can die during the lobby or mid-race,
      // and leaving the player on a screen whose peers are gone is a dead end.
      const next = createAppState(prev.settings)
      next.error = ev.message
      return next
    }

    case 'lobbyUpdated':
      return { ...prev, slots: copySlots(ev.slots) }

    case 'characterChosen': {
      if (!Number.isInteger(ev.characterIdx)) return prev
      if (ev.characterIdx < 0 || ev.characterIdx >= CHARACTERS.length) return prev
      // The choice lives in Settings, which is what persists it and what the
      // session reads. The lobby SLOT's characterIdx stays the room's to write, so
      // one fact keeps one owner.
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
      if (!known) return prev
      return { ...prev, trackId: ev.trackId }
    }

    case 'settingsChanged':
      return { ...prev, settings: ev.settings }

    case 'raceStarting':
      return { ...prev, screen: 'race', results: [], error: '' }

    case 'raceTick':
      // Deliberately state-free (Q14). `phase` and `finishedOrder` reach the screen
      // through the RaceView, which is their single source of truth; caching them
      // here would create the second copy, and the two would disagree by a tick.
      return prev

    case 'raceFinished':
      return { ...prev, screen: 'results', results: ev.results.slice() }

    case 'backToLobby':
      // Spec §5, step 7: back to the lobby with the room intact.
      return { ...prev, screen: 'lobby', results: [], error: '' }

    case 'quitToTitle':
      return createAppState(prev.settings)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/app.test.ts`
Expected: PASS, 30 tests.

Run: `npx vitest run`
Expected: PASS. Tasks 17 and 18's suites stay green.

Run: `npx tsc --noEmit -p packages/game/tsconfig.json`
Expected: **exactly one** error, and only until the next task lands:
`src/app.ts(N,M): error TS2307: Cannot find module './results' or its corresponding type declarations.`
Any other error is this task's to fix. If `Cannot find module '@tapkart/render'` appears as well, the
render package task has not landed yet — that is the same kind of forward reference and the same rule
applies: do not stub it.

- [ ] **Step 5: Commit**

```bash
git add packages/game/src/app.ts packages/game/test/app.test.ts \
        packages/game/test/fixtures/game-fixtures.ts && \
git commit -m "feat(game): the five-screen app state machine, pure and table-driven

Q14's five screens: title, characterSelect, lobby, race, results.
Countdown is not one of them - sim owns phase and the RaceView carries
it - and raceTick is legal on the race screen precisely so that it can
return prev BY REFERENCE and keep AppState from growing a second copy.
join/host are the title screen's buttons, with connecting and error
carrying the modal. SCREEN_TRANSITIONS is the single definition of
legality: reduceApp reads it, so the table and the reducer cannot drift.
Events naming content that does not ship - a character past the roster, a
track outside the manifest - are identity no-ops rather than crashes in
loadTrack."
```
