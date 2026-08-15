### Task 18: The DOM input adapter and settings persistence

**Files:**
- Create: `packages/game/src/controls/source.ts`
- Create: `packages/game/src/settings.ts`
- Modify: `packages/game/test/fixtures/game-fixtures.ts` (append `makeSettingsFixture`; do not rewrite the file)
- Test: `packages/game/test/settings.test.ts`
- Test: `packages/game/test/dom-seam.test.ts`

**`packages/game/src/roomcode.ts` is NOT created — contract §5.8 is retired.** Room codes ship in
`@tapkart/protocol` (`packages/protocol/src/room.ts`), and shipped code supersedes §5.8 three
separate times over: the **length is 5**, not 4; the alphabet is **Crockford base32**, which *keeps*
`0` and `1` and drops `I`, `L`, `O` and `U` — the opposite of the obvious ambiguity-free choice; and
**the alphabet's order is the 5-bit wire index**, so a differently-ordered alphabet is a different
wire format rather than a cosmetic difference. `normalizeRoomCode` there no longer strips or
truncates. A second copy in `game` would be a second wire format that agrees until someone reorders
one, so this task imports the six symbols and defines none of them.

Do **not** touch `packages/game/src/index.ts`. The barrel task (contract §5.15) re-exports `settings`
and deliberately **not** `controls/source` — it is a DOM adapter (§8.2), and a barrel
that re-exported it would drag `addEventListener` into every headless test in the repository. It no
longer re-exports `roomcode` either, because there is no such module.

**Interfaces:**

- Consumes, from Task 17 (`packages/game/src/controls/`):
  ```ts
  export type ControlScheme = 'thumbZones' | 'tilt' | 'virtualStick'
  export type PointerPhase = 'down' | 'move' | 'up'
  export interface PointerSample { id: number; x: number; y: number; phase: PointerPhase }
  export interface TiltSample { alpha: number; beta: number; gamma: number }
  export interface Viewport { width: number; height: number }
  export const MAX_POINTERS = 8
  export interface ControlInputs {
    pointers: PointerSample[]; pointerCount: number
    keys: Record<string, boolean>; tilt: TiltSample | null; viewport: Viewport
  }
  export function createControlInputs(): ControlInputs
  // controls/tilt.ts
  export interface TiltCalibration { betaZero: number; gammaZero: number }
  export const IDENTITY_TILT_CALIBRATION: Readonly<TiltCalibration>
  ```
  and `packages/game/test/fixtures/game-fixtures.ts`, which already exports
  `makeControlInputsFixture(overrides?: Partial<ControlInputs>): ControlInputs`.
- Consumes, from `@tapkart/content` (contract §3a.2, §3a.5):
  ```ts
  export interface TrackManifestEntry { id: string; name: string }
  /** The six shipped tracks in MENU ORDER, which is `id` ascending. */
  export const TRACK_MANIFEST: readonly TrackManifestEntry[]
  /** The shipped character table; length 8, index === characterIdx.
   *  `readonly`, and it does NOT assign to `SimContext.characters: CharacterStats[]`
   *  — a composition root writes `CHARACTERS.slice()`. (`TUNING: Readonly<Tuning>`
   *  *does* assign to `tuning: Tuning`; arrays are the case that bites.) */
  export const CHARACTERS: readonly CharacterStats[]
  ```
- Produces (contract §5.6 and §5.7 — 10 exported symbols; §11's census loses §5.8's four with `roomcode.ts`):
  ```ts
  // src/controls/source.ts (3)
  export interface InputSource { drain(out: ControlInputs): void; detach(): void }
  export function attachInputSource(target: EventTarget, viewport: Viewport): InputSource
  export function requestTiltPermission(): Promise<boolean>

  // src/settings.ts (7)
  export interface Settings {
    scheme: ControlScheme
    tiltCalibration: TiltCalibration
    invertTilt: boolean
    audioEnabled: boolean
    audioVolume: number         // 0..1
    characterIdx: number        // 0..7
    lastTrackId: string         // a TRACK_MANIFEST id
    playerName: string          // 1..12 chars after trimming; '' means "unset"
  }
  export const DEFAULT_SETTINGS: Readonly<Settings>
  export const SETTINGS_STORAGE_KEY = 'tapkart.settings.v1'
  export interface KeyValueStore { get(key: string): string | null; set(key: string, value: string): void }
  export function memoryStore(): KeyValueStore
  export function loadSettings(store: KeyValueStore): Settings
  export function saveSettings(store: KeyValueStore, s: Settings): void
  ```
  ```ts
  // test/fixtures/game-fixtures.ts — appended (contract §9.1)
  export function makeSettingsFixture(overrides?: Partial<Settings>): Settings
  ```

**A test-vacuity trap this task will walk into if warned about nothing else.** `it.each` **spreads
any row that is itself an array**, so `it.each([null, 42, [], true])` delivers the `[]` row as *zero*
arguments and silently re-tests `undefined`. An array-rejection bug passes under that form. Every
rejected-input table below is therefore `[label, value]` tuples, or a plain `for` loop. Do not
"simplify" them back to bare value lists.

**Where the seam sits (§8.2).** `source.ts` is one of exactly four files CI never imports: DOM event
listeners, `deviceorientation`, the iOS permission call. It has no unit test, and that is a decision,
not an omission — the compensating controls are `tsc` (it is inside `packages/game/tsconfig.json`'s
`include`) and `dom-seam.test.ts`, which proves that no *other* module in this task's or Task 17's
surface has quietly acquired a DOM dependency. `settings.ts` never names the browser's storage API: the store is
injected, which is what makes it testable under `environment: 'node'` with no jsdom (Q30). Note that
`dom-seam.test.ts` reads source files as **text**, comments included, so the pure modules must avoid
naming those APIs even in prose — write "browser storage", not the identifier.

- [ ] **Step 1: Write the failing test for `settings.ts`**

Append to `packages/game/test/fixtures/game-fixtures.ts` (Task 17 created this file with
`makeControlInputsFixture`; keep that export and add these two lines of imports at the top and the
function at the bottom):

```ts
import type { Settings } from '../../src/settings'
import { DEFAULT_SETTINGS } from '../../src/settings'

/** DEFAULT_SETTINGS with a fresh, independently mutable tiltCalibration. */
export function makeSettingsFixture(overrides?: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    tiltCalibration: { ...DEFAULT_SETTINGS.tiltCalibration },
    ...overrides,
  }
}
```

Create `packages/game/test/settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { CHARACTERS, TRACK_MANIFEST } from '@tapkart/content'
import { IDENTITY_TILT_CALIBRATION } from '../src/controls/tilt'
import type { Settings } from '../src/settings'
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  memoryStore,
  saveSettings,
} from '../src/settings'
import { makeSettingsFixture } from './fixtures/game-fixtures'

// Compile-time exhaustive: adding a field to Settings without adding it here is a
// type error, so the per-field fallback test can never silently skip a new field.
const KEY_TABLE: Record<keyof Settings, true> = {
  scheme: true,
  tiltCalibration: true,
  invertTilt: true,
  audioEnabled: true,
  audioVolume: true,
  characterIdx: true,
  lastTrackId: true,
  playerName: true,
}
const KEYS = Object.keys(KEY_TABLE) as (keyof Settings)[]

/** Every field DIFFERENT from DEFAULT_SETTINGS. That is what makes the per-field
 *  fallback test able to tell "one field reset" from "the whole object reset". */
const CUSTOM: Settings = {
  scheme: 'tilt',
  tiltCalibration: { betaZero: 3, gammaZero: -4 },
  invertTilt: true,
  audioEnabled: false,
  audioVolume: 0.25,
  characterIdx: 5,
  lastTrackId: TRACK_MANIFEST[1].id,
  playerName: 'Rae',
}

function storeWith(json: string): ReturnType<typeof memoryStore> {
  const store = memoryStore()
  store.set(SETTINGS_STORAGE_KEY, json)
  return store
}

describe('DEFAULT_SETTINGS', () => {
  it('is the contract §5.7 table, field by field', () => {
    expect(DEFAULT_SETTINGS.scheme).toBe('thumbZones')
    expect(DEFAULT_SETTINGS.tiltCalibration).toEqual(IDENTITY_TILT_CALIBRATION)
    expect(DEFAULT_SETTINGS.invertTilt).toBe(false)
    expect(DEFAULT_SETTINGS.audioEnabled).toBe(true)
    expect(DEFAULT_SETTINGS.audioVolume).toBe(0.7)
    expect(DEFAULT_SETTINGS.characterIdx).toBe(0)
    expect(DEFAULT_SETTINGS.playerName).toBe('')
    expect(SETTINGS_STORAGE_KEY).toBe('tapkart.settings.v1')
  })

  it('defaults lastTrackId to the first shipped track, not a hard-coded id', () => {
    // CATCHES a literal track id copied into settings.ts. The manifest is derived
    // from the shipped files; a renamed track would leave the default pointing at
    // a track loadTrack throws on, on first launch, for every new player.
    expect(DEFAULT_SETTINGS.lastTrackId).toBe(TRACK_MANIFEST[0].id)
    expect(TRACK_MANIFEST.some((t) => t.id === DEFAULT_SETTINGS.lastTrackId)).toBe(true)
  })
})

describe('memoryStore', () => {
  it('returns null for an unset key and round-trips what it is given', () => {
    const store = memoryStore()
    expect(store.get('nope')).toBeNull()
    store.set('k', 'v')
    expect(store.get('k')).toBe('v')
    store.set('k', 'w')
    expect(store.get('k')).toBe('w')
  })

  it('gives each store its own keyspace', () => {
    // CATCHES a module-level Map shared by every store, which makes one test's
    // settings leak into the next and is invisible until tests run in a new order.
    const a = memoryStore()
    const b = memoryStore()
    a.set('k', 'a')
    expect(b.get('k')).toBeNull()
  })
})

describe('loadSettings - whole-blob failures', () => {
  it('returns the defaults and never throws', () => {
    // [label, stored] tuples, NOT a bare list: it.each and any array-spreading
    // helper would swallow a row that is itself an array.
    const rows: [string, string][] = [
      ['not JSON at all', '{'],
      ['a JSON number', '42'],
      ['JSON null', 'null'],
      ['a JSON array', '[]'],
      ['a JSON string', '"thumbZones"'],
      ['an empty string', ''],
      ['a truncated object', '{"scheme":'],
    ]
    for (const [label, stored] of rows) {
      const got = loadSettings(storeWith(stored))
      expect(got, label).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('returns the defaults when nothing has ever been saved', () => {
    expect(loadSettings(memoryStore())).toEqual(DEFAULT_SETTINGS)
  })

  it('returns a fresh object each time, sharing nothing with DEFAULT_SETTINGS', () => {
    // CATCHES `return DEFAULT_SETTINGS` and a shallow copy that keeps the shared
    // tiltCalibration object. The settings screen writes into what it is handed;
    // either bug rewrites the module constant for the life of the process, and
    // "reset to defaults" then restores the corrupted values.
    const first = loadSettings(memoryStore())
    first.audioVolume = 0.1
    first.tiltCalibration.betaZero = 99
    const second = loadSettings(memoryStore())
    expect(second.audioVolume).toBe(0.7)
    expect(second.tiltCalibration).toEqual({ betaZero: 0, gammaZero: 0 })
    expect(DEFAULT_SETTINGS.audioVolume).toBe(0.7)
    expect(DEFAULT_SETTINGS.tiltCalibration).toEqual({ betaZero: 0, gammaZero: 0 })
    expect(first.tiltCalibration).not.toBe(second.tiltCalibration)
  })
})

describe('loadSettings - PER-FIELD fallback', () => {
  it('falls back only the broken field and keeps the other seven', () => {
    // THE FLAGSHIP TEST for §5.7. Every field of CUSTOM differs from the default,
    // so a per-OBJECT fallback - the natural implementation, and the one that
    // silently wipes a player's whole configuration because one field is stale
    // after an upgrade - fails on the very first row.
    const rows: [string, keyof Settings, unknown][] = [
      ['scheme is not a known scheme', 'scheme', 'gamepad'],
      ['scheme is a number', 'scheme', 3],
      ['tiltCalibration is null', 'tiltCalibration', null],
      ['tiltCalibration is a number', 'tiltCalibration', 7],
      ['tiltCalibration has a NaN axis', 'tiltCalibration', { betaZero: Number.NaN, gammaZero: 0 }],
      ['tiltCalibration is missing an axis', 'tiltCalibration', { betaZero: 1 }],
      ['invertTilt is a string', 'invertTilt', 'yes'],
      ['audioEnabled is a number', 'audioEnabled', 1],
      ['audioVolume is above 1', 'audioVolume', 1.5],
      ['audioVolume is negative', 'audioVolume', -0.2],
      ['audioVolume is a string', 'audioVolume', 'loud'],
      ['characterIdx is fractional', 'characterIdx', 1.5],
      ['characterIdx is past the roster', 'characterIdx', CHARACTERS.length],
      ['characterIdx is negative', 'characterIdx', -1],
      ['lastTrackId is not a shipped track', 'lastTrackId', 'atlantis'],
      ['lastTrackId is a number', 'lastTrackId', 3],
      ['playerName is 13 characters', 'playerName', 'abcdefghijklm'],
      ['playerName is blank after trimming', 'playerName', '   '],
      ['playerName is a number', 'playerName', 12],
    ]

    for (const [label, key, bad] of rows) {
      const stored: Record<string, unknown> = { ...CUSTOM }
      stored[key] = bad
      const got = loadSettings(storeWith(JSON.stringify(stored)))
      expect(got[key], `${label}: broken field must fall back`).toEqual(DEFAULT_SETTINGS[key])
      for (const other of KEYS) {
        if (other === key) continue
        expect(got[other], `${label}: ${other} must survive`).toEqual(CUSTOM[other])
      }
    }
  })

  it('accepts every legal value it is handed, unchanged', () => {
    // CATCHES an over-strict validator - the failure mode the test above cannot
    // see, because a loader that rejected EVERYTHING would pass it. Round-tripping
    // CUSTOM proves the accept path for all eight fields at once.
    const store = memoryStore()
    saveSettings(store, CUSTOM)
    expect(loadSettings(store)).toEqual(CUSTOM)
  })

  it('accepts the boundary values on both ends', () => {
    const edge: Settings = makeSettingsFixture({
      audioVolume: 0,
      characterIdx: CHARACTERS.length - 1,
      lastTrackId: TRACK_MANIFEST[TRACK_MANIFEST.length - 1].id,
      playerName: 'abcdefghijkl', // exactly 12
    })
    const store = memoryStore()
    saveSettings(store, edge)
    expect(loadSettings(store)).toEqual(edge)

    const full = makeSettingsFixture({ audioVolume: 1 })
    saveSettings(store, full)
    expect(loadSettings(store).audioVolume).toBe(1)
  })

  it('trims a padded player name rather than rejecting it', () => {
    const store = storeWith(JSON.stringify({ ...CUSTOM, playerName: '  Rae Vance ' }))
    expect(loadSettings(store).playerName).toBe('Rae Vance')
  })

  it('ignores unknown stored fields', () => {
    // CATCHES a loader that copies the parsed object wholesale; a v2 field left by
    // a newer build would then reappear in a v1 Settings and travel into save().
    const store = storeWith(JSON.stringify({ ...CUSTOM, hyperdrive: true }))
    const got = loadSettings(store)
    expect(Object.keys(got).sort()).toEqual([...KEYS].sort())
  })
})

describe('saveSettings', () => {
  it('writes JSON under SETTINGS_STORAGE_KEY and under no other key', () => {
    const store = memoryStore()
    saveSettings(store, CUSTOM)
    const raw = store.get(SETTINGS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toEqual(CUSTOM)
    expect(store.get('tapkart.settings')).toBeNull()
  })

  it('serialises every field, so nothing is silently dropped', () => {
    // CATCHES a hand-written serialiser that forgets a field: the round-trip test
    // above would still pass if the missing field happened to equal its default.
    const store = memoryStore()
    saveSettings(store, CUSTOM)
    const parsed = JSON.parse(store.get(SETTINGS_STORAGE_KEY) as string) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual([...KEYS].sort())
  })

  it('does not alias the settings it was handed', () => {
    const store = memoryStore()
    const s = makeSettingsFixture({ playerName: 'Rae' })
    saveSettings(store, s)
    s.playerName = 'Someone Else'
    expect(loadSettings(store).playerName).toBe('Rae')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/settings.test.ts`
Expected: FAIL with `Failed to resolve import "../src/settings" from "packages/game/test/settings.test.ts". Does the file exist?`

- [ ] **Step 3: Write `settings.ts`**

Create `packages/game/src/settings.ts`:

```ts
import { CHARACTERS, TRACK_MANIFEST } from '@tapkart/content'
import type { ControlScheme } from './controls/types'
import type { TiltCalibration } from './controls/tilt'
import { IDENTITY_TILT_CALIBRATION } from './controls/tilt'

export interface Settings {
  scheme: ControlScheme
  tiltCalibration: TiltCalibration
  invertTilt: boolean
  audioEnabled: boolean
  audioVolume: number // 0..1
  characterIdx: number // 0..7
  lastTrackId: string // a TRACK_MANIFEST id
  playerName: string // 1..12 chars after trimming; '' means "unset"
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  scheme: 'thumbZones',
  tiltCalibration: { ...IDENTITY_TILT_CALIBRATION },
  invertTilt: false,
  audioEnabled: true,
  audioVolume: 0.7,
  characterIdx: 0,
  // Derived from the shipped manifest, never a literal: TRACK_MANIFEST is built
  // from the track files' own ids, so this default cannot point at a track that
  // does not ship.
  lastTrackId: TRACK_MANIFEST[0].id,
  playerName: '',
}

export const SETTINGS_STORAGE_KEY = 'tapkart.settings.v1'

/** Injected so tests never touch browser storage - and so this module stays inside
 *  the headless half of §8.2's seam. The browser-backed store is built by the
 *  shell, which is the file allowed to name browser APIs. (This comment names none
 *  of them on purpose: dom-seam.test.ts reads this file as text.) */
export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

export function memoryStore(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    get(key: string): string | null {
      const v = map.get(key)
      return v === undefined ? null : v
    },
    set(key: string, value: string): void {
      map.set(key, value)
    },
  }
}

const PLAYER_NAME_MAX = 12

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function freshDefaults(): Settings {
  // A new object every call, with a new tiltCalibration: the settings screen
  // writes into whatever loadSettings returns, and DEFAULT_SETTINGS must survive
  // that untouched for the life of the process.
  return { ...DEFAULT_SETTINGS, tiltCalibration: { ...DEFAULT_SETTINGS.tiltCalibration } }
}

/**
 * NEVER throws. Malformed JSON, a missing key, a wrong type or an out-of-range
 * value falls back PER FIELD to DEFAULT_SETTINGS - not per object, so one bad
 * field does not discard the other seven. That difference is the whole point: a
 * field this build does not understand should cost the player that setting, not
 * their character, their track and their name.
 */
export function loadSettings(store: KeyValueStore): Settings {
  const out = freshDefaults()

  const raw = store.get(SETTINGS_STORAGE_KEY)
  if (raw === null) return out

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!isPlainObject(parsed)) return out

  const scheme = parsed.scheme
  if (scheme === 'thumbZones' || scheme === 'tilt' || scheme === 'virtualStick') {
    out.scheme = scheme
  }

  const cal = parsed.tiltCalibration
  if (isPlainObject(cal) && isFiniteNumber(cal.betaZero) && isFiniteNumber(cal.gammaZero)) {
    out.tiltCalibration = { betaZero: cal.betaZero, gammaZero: cal.gammaZero }
  }

  if (typeof parsed.invertTilt === 'boolean') out.invertTilt = parsed.invertTilt
  if (typeof parsed.audioEnabled === 'boolean') out.audioEnabled = parsed.audioEnabled

  const vol = parsed.audioVolume
  if (isFiniteNumber(vol) && vol >= 0 && vol <= 1) out.audioVolume = vol

  const idx = parsed.characterIdx
  if (isFiniteNumber(idx) && Number.isInteger(idx) && idx >= 0 && idx < CHARACTERS.length) {
    out.characterIdx = idx
  }

  const trackId = parsed.lastTrackId
  if (typeof trackId === 'string' && TRACK_MANIFEST.some((t) => t.id === trackId)) {
    out.lastTrackId = trackId
  }

  const name = parsed.playerName
  if (typeof name === 'string') {
    const trimmed = name.trim()
    if (trimmed.length >= 1 && trimmed.length <= PLAYER_NAME_MAX) out.playerName = trimmed
  }

  return out
}

/**
 * SOLE WRITER of the persisted settings (§7.2). Writes a fresh, field-complete
 * object rather than `s` itself, so an extra property riding on the caller's
 * object never reaches storage.
 */
export function saveSettings(store: KeyValueStore, s: Settings): void {
  const payload: Settings = {
    scheme: s.scheme,
    tiltCalibration: { betaZero: s.tiltCalibration.betaZero, gammaZero: s.tiltCalibration.gammaZero },
    invertTilt: s.invertTilt,
    audioEnabled: s.audioEnabled,
    audioVolume: s.audioVolume,
    characterIdx: s.characterIdx,
    lastTrackId: s.lastTrackId,
    playerName: s.playerName,
  }
  store.set(SETTINGS_STORAGE_KEY, JSON.stringify(payload))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/settings.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Write the failing test for `source.ts` and the seam**

Create `packages/game/test/dom-seam.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// §8.2: `controls/source.ts` is one of exactly four files CI never imports. This
// test never imports it either - it READS it, which is the only way to assert
// something about a DOM module under `environment: 'node'` without pulling the DOM
// into the run.
const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const CONTROLS = `${SRC}controls/`

const DOM_PATTERNS: [string, RegExp][] = [
  ['addEventListener', /\baddEventListener\b/],
  ['removeEventListener', /\bremoveEventListener\b/],
  ['window', /\bwindow\b/],
  ['document', /\bdocument\b/],
  ['navigator', /\bnavigator\b/],
  ['localStorage', /\blocalStorage\b/],
  ['DeviceOrientationEvent', /\bDeviceOrientationEvent\b/],
  ['PointerEvent', /\bPointerEvent\b/],
]

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('§8.2 DOM seam', () => {
  it('source.ts exists and is the file that owns the DOM', () => {
    // ANTI-VACUITY: this asserts the patterns below can actually match something.
    // Without it, a typo'd regex would make every "is DOM-free" assertion pass on
    // every file in the repository, forever.
    const src = read(`${CONTROLS}source.ts`)
    expect(src).toMatch(/\baddEventListener\b/)
    expect(src).toMatch(/\bremoveEventListener\b/)
    expect(src).toMatch(/deviceorientation/)
    expect(src).toMatch(/\bpointercancel\b/)
  })

  it('no other controls module names a DOM API', () => {
    // CATCHES the failure mode Q30 describes: a "pure" module quietly acquiring a
    // browser dependency, which surfaces later as an unrelated headless suite
    // breaking and gets "fixed" by switching the environment to jsdom.
    const files = readdirSync(CONTROLS).filter((f) => f.endsWith('.ts') && f !== 'source.ts')
    expect(files.length).toBeGreaterThanOrEqual(8)
    for (const f of files) {
      const text = read(`${CONTROLS}${f}`)
      for (const [name, re] of DOM_PATTERNS) {
        expect(re.test(text), `${f} must not name ${name}`).toBe(false)
      }
    }
  })

  it('settings.ts never names localStorage', () => {
    // Contract §5.7: the store is INJECTED. A direct localStorage read here would
    // make loadSettings untestable headlessly and would throw in a Safari private
    // window, on startup, before the first frame.
    for (const f of ['settings.ts']) {
      const text = read(`${SRC}${f}`)
      for (const [name, re] of DOM_PATTERNS) {
        expect(re.test(text), `${f} must not name ${name}`).toBe(false)
      }
    }
  })

  it('the controls entry point does not reach the DOM adapter', () => {
    // CATCHES `makeControlAdapter` growing a convenience that attaches listeners:
    // controls/index.ts IS re-exported by the package barrel (§5.15), so an import
    // of './source' there would drag the DOM into every headless test transitively.
    const index = read(`${CONTROLS}index.ts`)
    expect(index.includes('./source')).toBe(false)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/dom-seam.test.ts`
Expected: FAIL with `ENOENT: no such file or directory, open '<repo>/packages/game/src/controls/source.ts'`

- [ ] **Step 7: Write `source.ts`**

Create `packages/game/src/controls/source.ts`:

```ts
import type { ControlInputs, PointerPhase, TiltSample, Viewport } from './types'
import { MAX_POINTERS } from './types'

export interface InputSource {
  /** Copies everything accumulated since the last call into `out`, then clears its
   *  own accumulator. Never allocates: `out.pointers` is reused. */
  drain(out: ControlInputs): void
  detach(): void
}

/**
 * Attaches pointer, key and deviceorientation listeners. The ONLY file in
 * packages/game that references a DOM event (§8.2), and the reason the rest of the
 * package is testable under `environment: 'node'` with no jsdom.
 *
 * `viewport` is owned by the CALLER - the shell updates it on resize and `drain`
 * copies it. One owner for the canvas size, and it is not this module.
 *
 * `target` is the element the shell listens on; it passes `window` so that keys
 * and device orientation arrive alongside pointers.
 */
export function attachInputSource(target: EventTarget, viewport: Viewport): InputSource {
  // Fixed-size accumulator, allocated once. A frame that produces more than
  // MAX_POINTERS events drops the excess rather than growing an array in the
  // input path (§7.3).
  const ids = new Int32Array(MAX_POINTERS)
  const xs = new Float64Array(MAX_POINTERS)
  const ys = new Float64Array(MAX_POINTERS)
  const phases: PointerPhase[] = []
  for (let i = 0; i < MAX_POINTERS; i++) phases.push('up')
  let count = 0

  const keys: Record<string, boolean> = {}
  const tiltScratch: TiltSample = { alpha: 0, beta: 0, gamma: 0 }
  let haveTilt = false

  function push(id: number, x: number, y: number, phase: PointerPhase): void {
    if (count >= MAX_POINTERS) return
    ids[count] = id
    xs[count] = x
    ys[count] = y
    phases[count] = phase
    count++
  }

  function pointerHandler(phase: PointerPhase): (e: Event) => void {
    return (e: Event): void => {
      const p = e as PointerEvent
      // clientX/clientY are CSS px from the viewport's left/top edge, which is
      // exactly what PointerSample documents.
      push(p.pointerId, p.clientX, p.clientY, phase)
      if (e.cancelable) e.preventDefault()
    }
  }

  const onDown = pointerHandler('down')
  const onMove = pointerHandler('move')
  const onUp = pointerHandler('up')
  // A cancelled touch (a system gesture, an incoming call) never produces
  // 'pointerup'. Without this line the drift button stays latched for the rest of
  // the race and the player cannot release it.
  const onCancel = pointerHandler('up')

  const onKeyDown = (e: Event): void => {
    keys[(e as KeyboardEvent).code] = true
  }
  const onKeyUp = (e: Event): void => {
    keys[(e as KeyboardEvent).code] = false
  }
  // A key released while the window is unfocused never delivers 'keyup'. Clearing
  // on blur is what stops the kart driving itself after an alt-tab.
  const onBlur = (): void => {
    for (const code of Object.keys(keys)) keys[code] = false
  }

  const onOrientation = (e: Event): void => {
    const d = e as DeviceOrientationEvent
    if (d.alpha === null || d.beta === null || d.gamma === null) return
    tiltScratch.alpha = d.alpha
    tiltScratch.beta = d.beta
    tiltScratch.gamma = d.gamma
    haveTilt = true
  }

  target.addEventListener('pointerdown', onDown)
  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', onUp)
  target.addEventListener('pointercancel', onCancel)
  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('blur', onBlur)
  target.addEventListener('deviceorientation', onOrientation)

  return {
    drain(out: ControlInputs): void {
      for (let i = 0; i < count; i++) {
        const p = out.pointers[i]
        p.id = ids[i]
        p.x = xs[i]
        p.y = ys[i]
        p.phase = phases[i]
      }
      out.pointerCount = count
      count = 0

      // `keys` and `tiltScratch` are LEVELS, not edges: they persist across frames
      // and the adapters only read them. Aliasing rather than copying is what keeps
      // drain() allocation-free.
      out.keys = keys
      out.tilt = haveTilt ? tiltScratch : null
      out.viewport.width = viewport.width
      out.viewport.height = viewport.height
    },

    detach(): void {
      target.removeEventListener('pointerdown', onDown)
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onCancel)
      target.removeEventListener('keydown', onKeyDown)
      target.removeEventListener('keyup', onKeyUp)
      target.removeEventListener('blur', onBlur)
      target.removeEventListener('deviceorientation', onOrientation)
    },
  }
}

/** iOS's motion permission gate, which exists only on iOS and only as a static
 *  method the DOM lib does not declare. */
interface MotionPermissionGate {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>
}

/**
 * iOS requires a user-gesture-gated permission prompt for motion. Resolves `false`
 * when denied or unsupported.
 *
 * Q22: the CALLER reverts the selection and shows a reason; it does not silently
 * fall back. A player who selects tilt, is denied by the OS, and gets thumb-zones
 * with no explanation concludes the game is broken.
 */
export async function requestTiltPermission(): Promise<boolean> {
  const gate = (globalThis as { DeviceOrientationEvent?: MotionPermissionGate }).DeviceOrientationEvent
  if (gate === undefined) return false // no orientation API at all
  if (typeof gate.requestPermission !== 'function') return true // not iOS: no gate to pass
  try {
    return (await gate.requestPermission()) === 'granted'
  } catch {
    // iOS throws when the call is not inside a user gesture. That is a denial.
    return false
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/dom-seam.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Verify the package typechecks and the whole suite is green**

Run: `npx tsc --noEmit -p packages/game/tsconfig.json`
Expected: no output. This is the ONLY verification `source.ts` gets, by design (§8.2), so it is not
optional. If it reports `Cannot find name 'PointerEvent'` or `'DeviceOrientationEvent'`, the
package's `tsconfig.json` is missing `"lib": ["ES2022", "DOM", "DOM.Iterable"]` (§10.1) — fix the
tsconfig, never the source.

Run: `npx vitest run`
Expected: PASS. This task adds 19 tests across two files (15 + 4); Task 17's six suites stay green.

- [ ] **Step 10: Commit**

```bash
git add packages/game/src/controls/source.ts packages/game/src/settings.ts \
        packages/game/test/fixtures/game-fixtures.ts \
        packages/game/test/settings.test.ts \
        packages/game/test/dom-seam.test.ts && \
git commit -m "feat(game): DOM input source and per-field settings persistence

attachInputSource is the one file in packages/game that names a DOM
event (contract §8.2); pointercancel and blur are treated as releases so
a latched button cannot outlive the touch or the focus. requestTiltPermission
resolves false on denial or absence - Q22 leaves the revert-and-explain to
the caller. loadSettings never throws and falls back PER FIELD, so one
unreadable value costs the player that setting and not the other seven.
No roomcode.ts: contract §5.8 is retired by shipped
packages/protocol/src/room.ts, whose alphabet ORDER is the 5-bit wire
index, so a second copy here would be a second wire format."
```
