### Task 6: The DeepSeek content delegation — 8 character descriptors, 8 kart descriptors, 6 track themes

Rulings Q2 and Q3, contract §3a.3 and §3a.4. Twenty-two independent records against a
schema that is **locked before the batch runs** — which is the whole reason this is
answerable now — generated with `deepseek-batch`, gated by the game's own parsers, reviewed,
and committed.

**Why this is delegated at all.** Spec §10 names it as delegation work and it is a textbook
fit: 22 records, one fixed schema, no repo-wide context needed, reviewed before use, worth
about a nickel. The skill's own floor is "below roughly 20 items, do it yourself" — 22 is
just over it, and the margin comes entirely from the fact that all three record kinds share
**one instruction**, so the batch is one warm prompt cache rather than three cold ones.

**What is NOT delegated: balance.** The eight `CharacterStats` — `speed`, `accel`,
`handling`, `weight` — come from `makeCharacters()` and live in `CHARACTERS` (ruling Q1,
contract §3a.2). No model invents game balance. DeepSeek authors **names, palettes,
silhouette and proportions**, and the briefs hand it each slot's fixed stats as *input* so
the appearance can agree with the handling. `CharacterDescriptor.name` is the **displayed**
name — `CharacterStats.name` is `'Racer 3'` and is never shown — and the two arrays join
**by index only** (`KartState.characterIdx`), never by `id`.

**Why the gate is built from the real shipped code.** The gate script bundles the actual
`parseCharacterDescriptor`, `parseKartDescriptor` and `parseTrackTheme` with esbuild and
runs every generated record through them, so it rejects exactly what the game would reject.
**A gate that reimplements validation tests the gate.** This is not a new idea here: it is
the method `content/pipeline/` already used for the six shipped tracks — `validateTrack` and
`buildTrackQuery` bundled out of `packages/sim/src`, never rewritten — and that ladder
caught a 1.3 m surface overlap in `glacier-pass` and a completely undrivable
`neon-district`, neither of which a hand-written checker would have known to look for.

**Files:**
- Create: `content/pipeline/content-entry.ts`
- Create: `content/pipeline/descriptor-gen-instruction.md`
- Create: `content/pipeline/descriptors.jsonl`
- Create: `content/pipeline/gate-descriptors.mjs`
- Create (generated, gated, reviewed, committed):
  - `content/characters/character-0.json` … `character-7.json`
  - `content/karts/kart-0.json` … `kart-7.json`
  - `content/themes/{caldera,dust-canyon,glacier-pass,harbor-run,neon-district,redwood-rise}.json`
- Modify: `content/pipeline/README.md` (append one section — exact text in Step 3.8)
- Modify: `.gitignore` (repo root) — appends the three working-file patterns in Step 3.9. **This is the only task in this plan that edits `.gitignore`**, declared here so a reviewer seeing a root file in the diff knows it was intended.
- Create (generated, gitignored, never committed): `content/pipeline/content-bundle.mjs` (esbuild output), `content/pipeline/descriptors.jsonl.results.jsonl` (`deepseek-batch` output), `content/pipeline/records-out/` and its 22 staged `*.json`. `content/pipeline/descriptors-fix.jsonl` is created **only** on the regeneration path (Step 3.7); if that path runs, delete it before Step 5 — it is neither gitignored nor committed, and it would leave `git status` dirty.
- Test: `packages/content/test/roster.test.ts`

**Ordering.** This task needs Task 3 (`descriptors.ts`) and Task 4 (`theme.ts`) — the gate
imports both — and it must land **before Task 5**, whose `bundle.ts` statically imports all
22 files by exact path. Nothing here depends on Task 5.

**Interfaces:**

- Consumes (from **Task 3**, `packages/content/src/descriptors.ts`):
  - `type PaletteRGB = readonly [number, number, number]` — linear, each component `0..1`
  - `interface CharacterDescriptor { id: string; name: string; bodyHeight: number; bodyRadius: number; headRadius: number; palette: { primary: PaletteRGB; secondary: PaletteRGB; accent: PaletteRGB }; silhouette: 'compact' | 'tall' | 'wide' }`
  - `interface KartDescriptor { id: string; name: string; chassisLength: number; chassisWidth: number; chassisHeight: number; wheelRadius: number; wheelWidth: number; palette: { body: PaletteRGB; trim: PaletteRGB; wheel: PaletteRGB } }`
  - `function parseCharacterDescriptor(json: unknown): CharacterDescriptor`
  - `function parseKartDescriptor(json: unknown): KartDescriptor`
  - Task 3's decided semantics, which this task's gate must not restate differently:
    unknown keys are **rejected** (top level and inside `palette`); ranges are
    **inclusive** at both ends; every issue is collected into one `parseX: a; b; c`
    message; palettes are deep-copied; `NaN`/`Infinity` are rejected; `id` must match
    `^[a-z0-9]+(?:-[a-z0-9]+)*$`; `name` must be non-empty. **Uniqueness of `id` across
    the eight is deliberately NOT a per-record concern — it is this task's, because a
    per-record parser cannot see the other 21 records.**
- Consumes (from **Task 4**, `packages/content/src/theme.ts`):
  - `interface TrackTheme { trackId: string; road: PaletteRGB; roadDirt: PaletteRGB; shoulder: PaletteRGB; wall: PaletteRGB; ground: PaletteRGB; sky: { top: PaletteRGB; bottom: PaletteRGB }; fog: { color: PaletteRGB; near: number; far: number }; sunDirection: Vec3; ambient: number; edgeMarkers: EdgeMarkerParams }`
  - `interface EdgeMarkerParams { spacing: number; height: number; offset: number; colors: readonly [PaletteRGB, PaletteRGB] }`
  - `function parseTrackTheme(json: unknown): TrackTheme`
- Consumes (from **Task 2**, `packages/content/src/tuning.ts`, contract §3a.2) — as data
  copied into the briefs and the gate, not as an import:
  - `CHARACTERS[i].weight` = `[1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0]`
- Produces: the 22 JSON files above, consumed by Task 5's `bundle.ts`.

**Two conventions this task fixes, because nothing else can.**

1. **Filename is the slot; `id` is content.** `content/characters/character-3.json` is
   `characterIdx` 3 — the slot whose handling is `CHARACTERS[3]` — and its `id` is whatever
   the record's name slugs to. The filename carries the index because **index is the join**
   (§3a.3), and pinning filenames up front is also what lets Task 5 write 22 static import
   lines before the records exist. Theme files are named for their `trackId`, which *is*
   their key.
2. **The roster is alphabetical, one letter per slot: A, B, … H.** Contract §3a.6 orders
   `characters` and `karts` by `id` ascending, while the *stats* are per index — so if
   id-ascending order and slot order ever disagree, slot 5's appearance is handed slot 2's
   handling and no type catches it. Giving slot *i* the letter *i* makes the two orders
   agree by construction, and it makes the failure checkable: the gate asserts that
   `id` starts with the slot's letter, that the eight ids are unique, and that they are
   already sorted. An alphabetical character-select grid is also just how these games ship.

---

- [ ] **Step 1: Write the failing test**

Create `packages/content/test/roster.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { CharacterDescriptor, KartDescriptor, PaletteRGB } from '../src/descriptors'
import { parseCharacterDescriptor, parseKartDescriptor } from '../src/descriptors'
import type { TrackTheme } from '../src/theme'
import { parseTrackTheme } from '../src/theme'

/** Q34's test-only reach: the roster is judged as it ships, off disk. */
const CONTENT = fileURLToPath(new URL('../../../content/', import.meta.url))

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(CONTENT + rel, 'utf8')) as unknown
}

function stems(dir: string): string[] {
  return readdirSync(CONTENT + dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort()
}

/** CHARACTERS[i].weight, contract §3a.2 — the balance this content must look like. */
const WEIGHTS = [1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0]
const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const TRACK_IDS = [
  'caldera',
  'dust-canyon',
  'glacier-pass',
  'harbor-run',
  'neon-district',
  'redwood-rise',
]

function silhouetteFor(weight: number): 'compact' | 'tall' | 'wide' {
  if (weight >= 1.1) return 'wide'
  if (weight <= 0.9) return 'compact'
  return 'tall'
}

/**
 * Distance between two linear colours in a perceptual-ish space (component-wise sqrt).
 * Linear values crush dark colours together — two very different asphalt greys are
 * 0.02 apart in linear light — so a plain linear distance would call any two dark
 * palettes identical and any two bright ones different. The sqrt is a stand-in for the
 * display transfer function, which is what the player's eye actually sees.
 */
function visualDistance(a: PaletteRGB, b: PaletteRGB): number {
  const d0 = Math.sqrt(a[0]) - Math.sqrt(b[0])
  const d1 = Math.sqrt(a[1]) - Math.sqrt(b[1])
  const d2 = Math.sqrt(a[2]) - Math.sqrt(b[2])
  return Math.hypot(d0, d1, d2)
}

/** The same thresholds `gate-descriptors.mjs` applies before a record is accepted. */
const MIN_MARKER_PAIR = 0.25
const MIN_MARKER_SURFACE = 0.2
const MIN_ROAD_GROUND = 0.1
const MIN_KART_SEPARATION = 0.15
const MIN_THEME_SEPARATION = 0.1

function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const characters: CharacterDescriptor[] = []
const karts: KartDescriptor[] = []
const themes: TrackTheme[] = []
for (let i = 0; i < 8; i++) {
  characters.push(parseCharacterDescriptor(readJson(`characters/character-${i}.json`)))
  karts.push(parseKartDescriptor(readJson(`karts/kart-${i}.json`)))
}
for (const id of TRACK_IDS) {
  themes.push(parseTrackTheme(readJson(`themes/${id}.json`)))
}

describe('shipped roster files', () => {
  it('ships exactly 8 characters, 8 karts and 6 themes, and no stray file', () => {
    // Catches a `.ds` sidecar, a `character-8.json`, or a half-moved regeneration
    // landing in shipped content.
    expect(stems('characters')).toEqual([
      'character-0',
      'character-1',
      'character-2',
      'character-3',
      'character-4',
      'character-5',
      'character-6',
      'character-7',
    ])
    expect(stems('karts')).toEqual([
      'kart-0',
      'kart-1',
      'kart-2',
      'kart-3',
      'kart-4',
      'kart-5',
      'kart-6',
      'kart-7',
    ])
    expect(stems('themes')).toEqual([...TRACK_IDS].sort())
  })

  it('parses every record through the real parser', () => {
    // The module-scope loads above already threw if not; these pin the counts so a
    // silently-empty loop cannot pass.
    expect(characters).toHaveLength(8)
    expect(karts).toHaveLength(8)
    expect(themes).toHaveLength(6)
  })
})

describe('roster ordering', () => {
  it('gives slot i the letter i, so id-ascending order IS slot order', () => {
    // The bug: contract §3a.6 orders the bundle by id ascending while the STATS are per
    // index. If the two orders disagree, the heavyweight is drawn with the
    // featherweight's body and races with the featherweight's handling, and nothing in
    // the type system notices.
    for (let i = 0; i < 8; i++) {
      expect(characters[i].id.startsWith(LETTERS[i])).toBe(true)
      expect(karts[i].id.startsWith(LETTERS[i])).toBe(true)
    }
    const characterIds = characters.map((c) => c.id)
    const kartIds = karts.map((k) => k.id)
    expect(characterIds).toEqual([...characterIds].sort())
    expect(kartIds).toEqual([...kartIds].sort())
  })

  it('has unique ids and names, which no per-record parser can check', () => {
    const characterIds = characters.map((c) => c.id)
    const kartIds = karts.map((k) => k.id)
    expect(new Set(characterIds).size).toBe(8)
    expect(new Set(kartIds).size).toBe(8)
    expect(new Set(characters.map((c) => c.name)).size).toBe(8)
    expect(new Set(karts.map((k) => k.name)).size).toBe(8)
  })

  it('derives every id from its own displayed name', () => {
    for (const record of [...characters, ...karts]) {
      expect(slugOf(record.name)).toBe(record.id)
      expect(record.name.length).toBeGreaterThanOrEqual(3)
      expect(record.name.length).toBeLessThanOrEqual(18)
      expect(record.name[0]).toBe(record.name[0].toUpperCase())
    }
  })
})

describe('appearance agrees with the handling each slot is fixed to', () => {
  it('gives each character the silhouette its weight implies', () => {
    // Q2 hands the model the stats as INPUT so the field is readable: a player must be
    // able to see that the heavy kart is heavy. A silhouette chosen freely makes the
    // eight racers a lucky dip.
    for (let i = 0; i < 8; i++) {
      expect(characters[i].silhouette).toBe(silhouetteFor(WEIGHTS[i]))
    }
  })

  it('backs the silhouette up with the proportions', () => {
    for (let i = 0; i < 8; i++) {
      const c = characters[i]
      if (c.silhouette === 'wide') expect(c.bodyRadius).toBeGreaterThanOrEqual(0.38)
      if (c.silhouette === 'tall') expect(c.bodyHeight).toBeGreaterThanOrEqual(1.0)
      if (c.silhouette === 'compact') expect(c.bodyHeight).toBeLessThanOrEqual(0.95)
    }
  })

  it('sizes each kart to its paired racer', () => {
    for (let i = 0; i < 8; i++) {
      const k = karts[i]
      if (WEIGHTS[i] >= 1.1) {
        expect(k.chassisWidth).toBeGreaterThanOrEqual(1.35)
        expect(k.chassisLength).toBeGreaterThanOrEqual(2.1)
      }
      if (WEIGHTS[i] <= 0.9) {
        expect(k.chassisWidth).toBeLessThanOrEqual(1.15)
        expect(k.chassisLength).toBeLessThanOrEqual(1.9)
      }
    }
  })

  it('makes the eight kart bodies tellable apart', () => {
    // Eight karts in one pack on a phone screen. If two share a body colour the player
    // cannot find themselves, which is a gameplay failure, not a taste one.
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        const d = visualDistance(karts[i].palette.body, karts[j].palette.body)
        expect(d, `karts ${i} and ${j} share a body colour`).toBeGreaterThanOrEqual(
          MIN_KART_SEPARATION,
        )
      }
    }
  })
})

describe('themes', () => {
  it('themes exactly the six shipped tracks, each by its own id', () => {
    expect(themes.map((t) => t.trackId)).toEqual(TRACK_IDS)
  })

  it('keeps Q20 edge markers legible — the speed and corner cue', () => {
    // Q20: markers are gameplay. Two markers a player cannot tell apart give no cadence,
    // and markers that vanish into the road or the ground give nothing at all.
    for (const theme of themes) {
      const [a, b] = theme.edgeMarkers.colors
      expect(visualDistance(a, b), `${theme.trackId}: marker colours are too alike`).toBeGreaterThanOrEqual(
        MIN_MARKER_PAIR,
      )
      for (const c of [a, b]) {
        expect(visualDistance(c, theme.road), `${theme.trackId}: marker vs road`).toBeGreaterThanOrEqual(
          MIN_MARKER_SURFACE,
        )
        expect(visualDistance(c, theme.ground), `${theme.trackId}: marker vs ground`).toBeGreaterThanOrEqual(
          MIN_MARKER_SURFACE,
        )
      }
      expect(theme.edgeMarkers.spacing).toBeGreaterThanOrEqual(4)
      expect(theme.edgeMarkers.spacing).toBeLessThanOrEqual(40)
    }
  })

  it('keeps the road distinguishable from what is beside it', () => {
    for (const theme of themes) {
      expect(
        visualDistance(theme.road, theme.ground),
        `${theme.trackId}: road and ground are the same colour`,
      ).toBeGreaterThanOrEqual(MIN_ROAD_GROUND)
    }
  })

  it('gives the six tracks six different looks', () => {
    // The failure mode of a batch that ignored its per-record briefs is six palettes
    // that are the same palette. Compared over road + ground + sky.top together.
    for (let i = 0; i < themes.length; i++) {
      for (let j = i + 1; j < themes.length; j++) {
        const d = Math.hypot(
          visualDistance(themes[i].road, themes[j].road),
          visualDistance(themes[i].ground, themes[j].ground),
          visualDistance(themes[i].sky.top, themes[j].sky.top),
        )
        expect(
          d,
          `${themes[i].trackId} and ${themes[j].trackId} look the same`,
        ).toBeGreaterThanOrEqual(MIN_THEME_SEPARATION)
      }
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/content/test/roster.test.ts`

Expected: FAIL — the file fails to collect, because the module-scope loader throws before
any test runs:
`Error: ENOENT: no such file or directory, open '<repo>/content/characters/character-0.json'`

- [ ] **Step 3: Generate, gate, review, and place the 22 records**

**3.1 — Write the esbuild entry point.** Create `content/pipeline/content-entry.ts`:

```ts
// Entry point for the gate bundle: re-exports the REAL parsers so
// `gate-descriptors.mjs` judges a generated record with the same code the game runs.
// A second implementation of these rules could drift and accept records the game rejects.
export { parseCharacterDescriptor, parseKartDescriptor } from '../../packages/content/src/descriptors'
export { parseTrackTheme } from '../../packages/content/src/theme'
```

Bundle it (run from the repository root):

```bash
npx esbuild content/pipeline/content-entry.ts --bundle --format=esm \
  --platform=node --outfile=content/pipeline/content-bundle.mjs
```

Expected: `content/pipeline/content-bundle.mjs  ~7kb` and `⚡ Done in …ms`. The
`import type` lines in `theme.ts` erase, so no `@tapkart/sim` code is pulled in. Verify the
bundle is live before trusting it:

```bash
node -e "import('./content/pipeline/content-bundle.mjs').then(m => { console.log(Object.keys(m)); try { m.parseTrackTheme({}) } catch (e) { console.log(e.message.slice(0, 80)) } })"
```

Expected: `[ 'parseCharacterDescriptor', 'parseKartDescriptor', 'parseTrackTheme' ]` and a
`parseTrackTheme: trackId: must be a non-empty string, got undefined; …` message. If the
second line does not appear, the gate would pass everything, silently.

**3.2 — Write the instruction.** Create `content/pipeline/descriptor-gen-instruction.md`.
This file is sent **byte-identically with every one of the 22 jobs** — that is what warms
DeepSeek's prompt cache — so nothing per-record may appear in it:

````markdown
You are generating one record of shipped content for a kart-racing game, as a single
JSON object. Output ONLY the JSON object. No prose, no markdown fence, no trailing
commentary.

The input body says which KIND of record to write — `character`, `kart` or `theme` — and
gives that record's brief. Everything below is fixed and identical for every record.

# Colour is LINEAR 0..1 — not sRGB, not hex, not 0..255

Every colour is `[r, g, b]`: three JSON numbers, each between 0 and 1, in LINEAR light.
This is the single rule most likely to be got wrong, so read it twice. A mid-grey that
looks like #808080 on a screen is about **0.22** linear, not 0.5. Anchors:

| Surface | linear value |
|---|---|
| fresh asphalt, basalt, night water | 0.02 – 0.06 |
| dark soil, wet stone, deep foliage | 0.05 – 0.12 |
| dry sand, concrete, weathered wood | 0.15 – 0.35 |
| bright paint, lit foliage | 0.3 – 0.6 |
| snow, white paint, sunlit cloud | 0.6 – 0.9 |
| neon or emissive accent | 0.7 – 1.0 in one or two channels, near 0 in the others |

Three decimals is plenty. Never write a hex string.

# kind: character

```
{ "id": string, "name": string,
  "bodyHeight": number, "bodyRadius": number, "headRadius": number,
  "palette": { "primary": [r,g,b], "secondary": [r,g,b], "accent": [r,g,b] },
  "silhouette": "compact" | "tall" | "wide" }
```

- `name` is the DISPLAYED name and the only thing a player ever sees. One or two words,
  3 to 18 characters, beginning with the CAPITAL LETTER the body gives you. Invent
  people: no living or historical person, no brand, no trademark, no franchise name.
- `id` is `name`, lowercased, with apostrophes and full stops removed and every run of
  non-alphanumeric characters replaced by a single `-`. "Ada Flint" becomes "ada-flint".
  Nothing else is accepted.
- `bodyHeight` 0.4 – 1.4, `bodyRadius` 0.15 – 0.5, `headRadius` 0.1 – 0.4. Metres.
- `silhouette` — copy the value the body gives you. It is derived from handling numbers
  this record does not carry and it is not yours to choose. Then match it:
  - `wide` → `bodyRadius` at least 0.38
  - `tall` → `bodyHeight` at least 1.00
  - `compact` → `bodyHeight` at most 0.95
- `palette.primary` is the racer's main colour and must be one a player can name at a
  glance; `secondary` supports it; `accent` is a small bright highlight.

# kind: kart

```
{ "id": string, "name": string,
  "chassisLength": number, "chassisWidth": number, "chassisHeight": number,
  "wheelRadius": number, "wheelWidth": number,
  "palette": { "body": [r,g,b], "trim": [r,g,b], "wheel": [r,g,b] } }
```

- `name` and `id` follow the same two rules as a character, including the capital letter
  the body gives you.
- `chassisLength` 1.4 – 2.6, `chassisWidth` 0.9 – 1.6, `chassisHeight` 0.3 – 0.8,
  `wheelRadius` 0.2 – 0.45, `wheelWidth` 0.1 – 0.35. Metres.
- The body gives a weight class. Match it:
  - `heavy` → `chassisWidth` at least 1.35 AND `chassisLength` at least 2.10
  - `light` → `chassisWidth` at most 1.15 AND `chassisLength` at most 1.90
  - `medium` → anything in range
- `palette.body` is how a player finds their own kart in a pack of eight on a phone
  screen. The body brief names your colour family; stay inside it, and make it vivid.
- `palette.wheel` is rubber: 0.01 – 0.05 in every channel unless the brief says otherwise.

# kind: theme

```
{ "trackId": string,
  "road": [r,g,b], "roadDirt": [r,g,b], "shoulder": [r,g,b],
  "wall": [r,g,b], "ground": [r,g,b],
  "sky": { "top": [r,g,b], "bottom": [r,g,b] },
  "fog": { "color": [r,g,b], "near": number, "far": number },
  "sunDirection": { "x": number, "y": number, "z": number },
  "ambient": number,
  "edgeMarkers": { "spacing": number, "height": number, "offset": number,
                   "colors": [ [r,g,b], [r,g,b] ] } }
```

- `trackId` — copy the id in the body EXACTLY. It is not yours to invent.
- `road` is tarmac, `roadDirt` the dirt sections, `shoulder` the run-off just outside the
  racing line, `wall` the barrier, `ground` everything beyond. `road` and `ground` must
  NOT be near-identical: the player has to see where the drivable surface ends.
- `fog.near` and `fog.far` are metres and `near` must be less than `far`. Typical: near
  40 – 150, far 350 – 1200. Night, snow and storm fog closer than open desert.
- `ambient` is 0 – 1: how much light reaches surfaces facing away from the sun. Overcast
  and snow are high (0.4 – 0.6); night and deep canyon are low (0.1 – 0.25).
- `sunDirection` MUST be a unit vector; the parser rejects it when |v| differs from 1 by
  more than 0.000001. Do not compute one — **copy one row of this table verbatim**:

| sun | x | y | z |
|---|---|---|---|
| high, ahead-right | 0.360 | 0.800 | 0.480 |
| high, ahead-left | -0.360 | 0.800 | 0.480 |
| high, behind-right | 0.480 | 0.800 | -0.360 |
| high, behind-left | -0.480 | 0.800 | -0.360 |
| overhead, slightly right | 0.280 | 0.960 | 0.000 |
| overhead, slightly behind | 0.000 | 0.960 | -0.280 |
| mid, from the right | 0.600 | 0.640 | 0.480 |
| mid, behind-left | -0.600 | 0.640 | -0.480 |
| low evening, from ahead | 0.480 | 0.600 | 0.640 |
| low evening, from the left | -0.640 | 0.600 | 0.480 |

- `edgeMarkers` are the posts along both track edges. They are the player's speed cue and
  their read on the next corner — gameplay, not decoration:
  - `spacing` 4 – 40 metres between posts. 10 – 16 is what reads as speed at 40 m/s; 40
    reads as almost no markers at all.
  - `height` 0.3 – 2.0, `offset` 0 – 3 metres outboard of the road edge.
  - `colors` is exactly two colours, alternating post by post. They must be strongly
    different from each other AND clearly visible against BOTH `road` and `ground`. One
    bright colour and one dark saturated colour is the reliable pair.

# Rules for every record

1. Output exactly one JSON object and nothing else.
2. No key that is not listed above — not at the top level and not inside `palette`,
   `sky`, `fog`, `sunDirection` or `edgeMarkers`. The parser rejects unknown keys, so a
   record carrying a "description" or "notes" field is thrown away whole.
3. No key omitted.
4. Every number is a JSON number: no strings, no `null`, no `NaN`, no `Infinity`, no
   arithmetic, no units.
5. Every range above is inclusive at both ends.
6. This record carries NO speed, acceleration, handling, weight or any other balance
   number. Those are fixed elsewhere in the game and a record that invents one is thrown
   away.
````

**3.3 — Write the briefs.** Create `content/pipeline/descriptors.jsonl` — 22 lines, one
JSON object per line, `id` naming the output file and `brief` carrying everything
per-record. **Nothing in a brief may be moved into the instruction**, or the cache stops
warming:

```jsonl
{"id": "character-0", "brief": "kind: character. Roster slot 0 of 8. The displayed name must begin with the capital letter A. silhouette: tall - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 1.00, acceleration 1.00, handling 1.00, weight 1.00. Archetype: the baseline all-rounder, the racer a new player is handed first. Nothing exceptional in any direction. Approachable rather than aggressive. Colour family: crimson red, shared with kart slot A."}
{"id": "character-1", "brief": "kind: character. Roster slot 1 of 8. The displayed name must begin with the capital letter B. silhouette: wide - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 1.10, acceleration 0.85, handling 0.90, weight 1.20. Archetype: a heavy runner with a high top end and lazy turn-in. Should look like something that takes a while to get going and then does not stop. Colour family: amber orange, shared with kart slot B."}
{"id": "character-2", "brief": "kind: character. Roster slot 2 of 8. The displayed name must begin with the capital letter C. silhouette: compact - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 0.92, acceleration 1.15, handling 1.10, weight 0.85. Archetype: a light darting racer, quickest off the line, low top speed. Small and quick-looking. Colour family: teal, shared with kart slot C."}
{"id": "character-3", "brief": "kind: character. Roster slot 3 of 8. The displayed name must begin with the capital letter D. silhouette: wide - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 1.05, acceleration 0.90, handling 0.95, weight 1.10. Archetype: a long-haul cruiser, slightly heavy, strong top end, unhurried. Colour family: deep blue, shared with kart slot D."}
{"id": "character-4", "brief": "kind: character. Roster slot 4 of 8. The displayed name must begin with the capital letter E. silhouette: compact - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 0.95, acceleration 1.10, handling 1.05, weight 0.90. Archetype: light and responsive, modest top speed, the technical driver's pick. Colour family: lime green, shared with kart slot E."}
{"id": "character-5", "brief": "kind: character. Roster slot 5 of 8. The displayed name must begin with the capital letter F. silhouette: wide - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 1.15, acceleration 0.80, handling 0.85, weight 1.30. Archetype: the heavyweight. Fastest in a straight line and worst at everything else. The biggest racer on the grid by a clear margin. Colour family: violet, shared with kart slot F."}
{"id": "character-6", "brief": "kind: character. Roster slot 6 of 8. The displayed name must begin with the capital letter G. silhouette: compact - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 0.88, acceleration 1.20, handling 1.15, weight 0.80. Archetype: the featherweight. Best acceleration and best handling in the game, lowest top speed. The smallest racer on the grid. Colour family: white and pale cyan, shared with kart slot G."}
{"id": "character-7", "brief": "kind: character. Roster slot 7 of 8. The displayed name must begin with the capital letter H. silhouette: tall - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 1.00, acceleration 1.00, handling 1.00, weight 1.00. Archetype: the second baseline. Identical handling to slot A and must look nothing like them - a different build, a different attitude, a different palette. Colour family: magenta, shared with kart slot H."}
{"id": "kart-0", "brief": "kind: kart. Roster slot 0 of 8, the kart of the slot A racer. The displayed name must begin with the capital letter A. Weight class: medium. Character: an honest, unremarkable machine, the one every other kart is measured against. Colour family: crimson red. Wheels are plain black rubber."}
{"id": "kart-1", "brief": "kind: kart. Roster slot 1 of 8, the kart of the slot B racer. The displayed name must begin with the capital letter B. Weight class: heavy. Character: a long slab of a kart with a high top end and no interest in corners. Colour family: amber orange. Wheels are plain black rubber."}
{"id": "kart-2", "brief": "kind: kart. Roster slot 2 of 8, the kart of the slot C racer. The displayed name must begin with the capital letter C. Weight class: light. Character: a tiny darting frame that looks like it accelerates out of a corner faster than it enters one. Colour family: teal. Wheels are plain black rubber."}
{"id": "kart-3", "brief": "kind: kart. Roster slot 3 of 8, the kart of the slot D racer. The displayed name must begin with the capital letter D. Weight class: heavy. Character: a broad touring machine built for long straights, slightly softer-edged than the slot B kart. Colour family: deep blue. Wheels are plain black rubber."}
{"id": "kart-4", "brief": "kind: kart. Roster slot 4 of 8, the kart of the slot E racer. The displayed name must begin with the capital letter E. Weight class: light. Character: a nimble technical frame, narrow and low, built to change direction. Colour family: lime green. Wheels are plain black rubber."}
{"id": "kart-5", "brief": "kind: kart. Roster slot 5 of 8, the kart of the slot F racer. The displayed name must begin with the capital letter F. Weight class: heavy. Character: the biggest kart on the grid, wider and longer than every other, and it should look immovable. Colour family: violet. Wheels are plain black rubber."}
{"id": "kart-6", "brief": "kind: kart. Roster slot 6 of 8, the kart of the slot G racer. The displayed name must begin with the capital letter G. Weight class: light. Character: the smallest and lightest kart on the grid, barely more than a seat and four wheels. Colour family: white and pale cyan. Wheels are plain black rubber."}
{"id": "kart-7", "brief": "kind: kart. Roster slot 7 of 8, the kart of the slot H racer. The displayed name must begin with the capital letter H. Weight class: medium. Character: the second balanced kart, and it must not read as a recolour of the slot A kart. Colour family: magenta. Wheels are plain black rubber."}
{"id": "theme-caldera", "brief": "kind: theme. trackId: caldera - copy it exactly. The track is a 48-point loop inside a live volcanic caldera: tarmac with long dirt sections, corners banked to 20 degrees either way, elevation from -9 m to +9 m, road 15 to 19 m wide. Palette: black basalt tarmac, warm grey volcanic ash for the dirt, ground of cooled lava with a dull red glow in its cracks, smoke-heavy sky that is near-black overhead and hot orange at the horizon. Low evening sun, warm close fog, low ambient. There are no props, buildings or crowd anywhere in this game - the name describes the palette."}
{"id": "theme-dust-canyon", "brief": "kind: theme. trackId: dust-canyon - copy it exactly. The track is a dry desert canyon with a loose river bed cutting through it: about a fifth of the lap is dirt, road 15 to 20 m wide, elevation dropping 14 m into the canyon and climbing back. Palette: sun-bleached pale tarmac, red-brown river-bed dirt, sandstone walls, dusty scrub ground. Enormous hard sky, high sun, thin far-reaching haze rather than close fog, high ambient. There are no props, buildings or crowd anywhere in this game - the name describes the palette."}
{"id": "theme-glacier-pass", "brief": "kind: theme. trackId: glacier-pass - copy it exactly. The track is a wide all-tarmac run through an ice field, 21 to 26 m wide, banked one way only, elevation -9 m to +5 m. Palette: cold dark tarmac still wet from melt, blue-white packed snow on the ground, pale ice walls, an overcast sky that is bright and nearly colourless. High ambient, mid-distance fog, no strong sun colour. Edge markers must survive being seen against snow - do not make both of them pale. There are no props, buildings or crowd anywhere in this game - the name describes the palette."}
{"id": "theme-harbor-run", "brief": "kind: theme. trackId: harbor-run - copy it exactly. The track is a sunlit coastal harbour, all tarmac, 21 to 24 m wide, almost flat with one shallow bridge rise. Palette: warm grey harbour concrete, salt-bleached shoulder, painted steel barriers, deep blue-green harbour water as the ground. Bright midday sky, clean far visibility, high ambient. There are no props, buildings or crowd anywhere in this game - the name describes the palette."}
{"id": "theme-neon-district", "brief": "kind: theme. trackId: neon-district - copy it exactly. The track is a flat night city circuit, all tarmac, 18 to 22 m wide, no elevation change at all. Palette: wet black asphalt - the darkest surface on the track, around 0.02 - with the ground beyond it a cold blue-violet pavement roughly twice as bright as the road in the blue channel, so the edge of the drivable surface is still readable at night. Barriers lit by signage, a night sky that is deep blue-black above and a dirty magenta glow at the horizon. Accents are neon magenta and cyan. Low ambient, close fog, low sun. There are no props, buildings or crowd anywhere in this game - the name describes the palette."}
{"id": "theme-redwood-rise", "brief": "kind: theme. trackId: redwood-rise - copy it exactly. The track is a long forest climb, tarmac with dirt sections, 19 to 24 m wide, rising 22 m over the lap. Palette: damp dark tarmac under tree cover, red-brown needle-strewn dirt, deep green forest floor as the ground, warm bark-coloured barriers, and a sky mostly hidden by canopy - green-tinged and bright at the horizon where the light comes through. Mid ambient, mid fog. There are no props, buildings or crowd anywhere in this game - the name describes the palette."}
```

**3.4 — Dry-run first, always.**

```bash
deepseek-batch --jsonl content/pipeline/descriptors.jsonl --body-field brief --id-field id \
  --instruction @content/pipeline/descriptor-gen-instruction.md \
  --expect json --model deepseek-v4-pro --label descriptors-v1 --dry-run
```

Expected: 22 jobs listed, a token/cost estimate, and **no network call at all** — the
dry-run is fully offline, not even a balance check, and costs nothing. If it reports fewer
than 22 jobs, a JSONL line is malformed.

**3.5 — Run it.**

```bash
deepseek-batch --jsonl content/pipeline/descriptors.jsonl --body-field brief --id-field id \
  --instruction @content/pipeline/descriptor-gen-instruction.md \
  --expect json --model deepseek-v4-pro --label descriptors-v1 --max-spend 1.00 --json
```

Results land in `content/pipeline/descriptors.jsonl.results.jsonl`, one
`{id, ok, content, usage, error}` per line. Expect a few cents total.

**Expect the cache hit rate to look terrible on this run, and change nothing because of
it.** DeepSeek's prompt cache warms *across* runs, not within one: a byte-identical prefix
that has never been sent before comes back as almost all misses the first time — the track
pipeline in this same directory measured 15% on its first run and 95.5% on the next with
only the bodies changed. A low first-run rate is expected and is not a signal to reword
anything. A rate that stays low across repeated runs of the *same* instruction is the real
problem, and it means the instruction is varying between jobs — which here would mean
per-record text leaked out of `brief` and into the instruction file.

**3.6 — Gate with the real parsers.** Create `content/pipeline/gate-descriptors.mjs`:

```js
// Gate DeepSeek-generated descriptor and theme records with the REAL parsers from
// packages/content/src (bundled by esbuild in step 3.1, never reimplemented). A gate
// that re-implements validation tests the gate.
//
// Two layers, and the second is the one a parser cannot do: per-record shape and range
// via parseCharacterDescriptor / parseKartDescriptor / parseTrackTheme, then roster-wide
// rules — uniqueness, ordering, slot agreement, and the legibility thresholds — which
// need all 22 records at once.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import {
  parseCharacterDescriptor,
  parseKartDescriptor,
  parseTrackTheme,
} from './content-bundle.mjs'

const resultsPath = process.argv[2] ?? 'content/pipeline/descriptors.jsonl.results.jsonl'
const outDir = 'content/pipeline/records-out'
mkdirSync(outDir, { recursive: true })

const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const WEIGHTS = [1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0] // CHARACTERS[i].weight, §3a.2
const TRACK_IDS = [
  'caldera',
  'dust-canyon',
  'glacier-pass',
  'harbor-run',
  'neon-district',
  'redwood-rise',
]

// The same thresholds packages/content/test/roster.test.ts asserts on the committed files.
const MIN_MARKER_PAIR = 0.25
const MIN_MARKER_SURFACE = 0.2
const MIN_ROAD_GROUND = 0.1
const MIN_KART_SEPARATION = 0.15
const MIN_THEME_SEPARATION = 0.1

const silhouetteFor = (w) => (w >= 1.1 ? 'wide' : w <= 0.9 ? 'compact' : 'tall')

/** Linear light crushes dark colours together; the sqrt stands in for the display
 *  transfer function, so "different" means what the eye would call different. */
const visualDistance = (a, b) =>
  Math.hypot(
    Math.sqrt(a[0]) - Math.sqrt(b[0]),
    Math.sqrt(a[1]) - Math.sqrt(b[1]),
    Math.sqrt(a[2]) - Math.sqrt(b[2]),
  )

const slugOf = (name) =>
  name
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const fail = []
const records = new Map()

const lines = readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean)
for (const line of lines) {
  const res = JSON.parse(line)
  if (!res.ok) {
    fail.push(`${res.id}: API ERROR: ${res.error}`)
    continue
  }
  let obj
  try {
    obj = JSON.parse(res.content)
  } catch (e) {
    fail.push(`${res.id}: NOT JSON: ${e.message}`)
    continue
  }
  try {
    if (res.id.startsWith('character-')) records.set(res.id, parseCharacterDescriptor(obj))
    else if (res.id.startsWith('kart-')) records.set(res.id, parseKartDescriptor(obj))
    else if (res.id.startsWith('theme-')) records.set(res.id, parseTrackTheme(obj))
    else fail.push(`${res.id}: not a character-, kart- or theme- record id`)
  } catch (e) {
    fail.push(`${res.id}: ${e.message}`)
  }
}

// ---- roster rules: what no single-record parser can see -----------------------------
const characters = []
const karts = []
for (let i = 0; i < 8; i++) {
  const c = records.get(`character-${i}`)
  const k = records.get(`kart-${i}`)
  if (!c) fail.push(`character-${i}: missing from the results`)
  if (!k) fail.push(`kart-${i}: missing from the results`)
  if (!c || !k) continue
  characters.push(c)
  karts.push(k)

  const want = silhouetteFor(WEIGHTS[i])
  if (c.silhouette !== want) {
    fail.push(`character-${i}: silhouette '${c.silhouette}' but weight ${WEIGHTS[i]} means '${want}'`)
  }
  if (want === 'wide' && !(c.bodyRadius >= 0.38)) {
    fail.push(`character-${i}: wide needs bodyRadius >= 0.38, got ${c.bodyRadius}`)
  }
  if (want === 'tall' && !(c.bodyHeight >= 1.0)) {
    fail.push(`character-${i}: tall needs bodyHeight >= 1.00, got ${c.bodyHeight}`)
  }
  if (want === 'compact' && !(c.bodyHeight <= 0.95)) {
    fail.push(`character-${i}: compact needs bodyHeight <= 0.95, got ${c.bodyHeight}`)
  }
  if (WEIGHTS[i] >= 1.1 && !(k.chassisWidth >= 1.35 && k.chassisLength >= 2.1)) {
    fail.push(`kart-${i}: heavy needs width >= 1.35 and length >= 2.10, got ${k.chassisWidth} / ${k.chassisLength}`)
  }
  if (WEIGHTS[i] <= 0.9 && !(k.chassisWidth <= 1.15 && k.chassisLength <= 1.9)) {
    fail.push(`kart-${i}: light needs width <= 1.15 and length <= 1.90, got ${k.chassisWidth} / ${k.chassisLength}`)
  }
  for (const [kind, r] of [['character', c], ['kart', k]]) {
    if (!r.id.startsWith(LETTERS[i])) {
      fail.push(`${kind}-${i}: id '${r.id}' does not start with '${LETTERS[i]}' — slot order and id order must agree`)
    }
    if (slugOf(r.name) !== r.id) {
      fail.push(`${kind}-${i}: id '${r.id}' is not the slug of name '${r.name}'`)
    }
    if (r.name.length < 3 || r.name.length > 18) {
      fail.push(`${kind}-${i}: name '${r.name}' must be 3-18 characters`)
    }
  }
}

for (const [label, list] of [['character', characters], ['kart', karts]]) {
  const ids = list.map((r) => r.id)
  if (new Set(ids).size !== ids.length) fail.push(`${label} ids are not unique: ${ids.join(', ')}`)
  if (ids.join('\0') !== [...ids].sort().join('\0')) {
    fail.push(`${label} ids are not in ascending order: ${ids.join(', ')}`)
  }
}

for (let i = 0; i < karts.length; i++) {
  for (let j = i + 1; j < karts.length; j++) {
    const d = visualDistance(karts[i].palette.body, karts[j].palette.body)
    if (d < MIN_KART_SEPARATION) {
      fail.push(`kart-${i} and kart-${j}: body colours are ${d.toFixed(3)} apart, need ${MIN_KART_SEPARATION}`)
    }
  }
}

const themes = []
for (const tid of TRACK_IDS) {
  const t = records.get(`theme-${tid}`)
  if (!t) {
    fail.push(`theme-${tid}: missing from the results`)
    continue
  }
  themes.push(t)
  if (t.trackId !== tid) fail.push(`theme-${tid}: trackId is '${t.trackId}'`)
  const [a, b] = t.edgeMarkers.colors
  if (visualDistance(a, b) < MIN_MARKER_PAIR) {
    fail.push(`theme-${tid}: the two marker colours are too alike (${visualDistance(a, b).toFixed(3)})`)
  }
  for (const [name, surface] of [['road', t.road], ['ground', t.ground]]) {
    for (const c of [a, b]) {
      if (visualDistance(c, surface) < MIN_MARKER_SURFACE) {
        fail.push(`theme-${tid}: a marker colour vanishes into ${name} (${visualDistance(c, surface).toFixed(3)})`)
      }
    }
  }
  if (visualDistance(t.road, t.ground) < MIN_ROAD_GROUND) {
    fail.push(`theme-${tid}: road and ground are the same colour (${visualDistance(t.road, t.ground).toFixed(3)})`)
  }
}

for (let i = 0; i < themes.length; i++) {
  for (let j = i + 1; j < themes.length; j++) {
    const d = Math.hypot(
      visualDistance(themes[i].road, themes[j].road),
      visualDistance(themes[i].ground, themes[j].ground),
      visualDistance(themes[i].sky.top, themes[j].sky.top),
    )
    if (d < MIN_THEME_SEPARATION) {
      fail.push(`${themes[i].trackId} and ${themes[j].trackId}: the palettes are ${d.toFixed(3)} apart`)
    }
  }
}

// ---- the review table, and staging ---------------------------------------------------
const rgb = (c) => `[${c.map((v) => v.toFixed(2)).join(' ')}]`

console.log('\nCHARACTERS')
for (let i = 0; i < 8; i++) {
  const c = records.get(`character-${i}`)
  if (!c) continue
  console.log(
    `  ${i}  ${c.id.padEnd(20)} ${c.name.padEnd(18)} ${c.silhouette.padEnd(8)} ` +
      `h=${c.bodyHeight} r=${c.bodyRadius} head=${c.headRadius}  ${rgb(c.palette.primary)}`,
  )
}
console.log('\nKARTS')
for (let i = 0; i < 8; i++) {
  const k = records.get(`kart-${i}`)
  if (!k) continue
  console.log(
    `  ${i}  ${k.id.padEnd(20)} ${k.name.padEnd(18)} ` +
      `L=${k.chassisLength} W=${k.chassisWidth} H=${k.chassisHeight}  body=${rgb(k.palette.body)}`,
  )
}
console.log('\nTHEMES')
for (const tid of TRACK_IDS) {
  const t = records.get(`theme-${tid}`)
  if (!t) continue
  console.log(
    `  ${t.trackId.padEnd(15)} road=${rgb(t.road)} ground=${rgb(t.ground)} ` +
      `sky=${rgb(t.sky.top)} amb=${t.ambient} fog=${t.fog.near}-${t.fog.far} ` +
      `posts@${t.edgeMarkers.spacing}m ${rgb(t.edgeMarkers.colors[0])}/${rgb(t.edgeMarkers.colors[1])}`,
  )
}

for (const [id, record] of records) {
  writeFileSync(`${outDir}/${id}.json`, JSON.stringify(record, null, 2) + '\n')
}

if (fail.length > 0) {
  console.log(`\n${fail.length} PROBLEM(S):`)
  for (const f of fail) console.log(`  - ${f}`)
  console.log(`\n${records.size} of 22 records parsed; nothing is shipped until this is clean.`)
  process.exitCode = 1
} else {
  console.log(`\n22 records valid — staged in ${outDir}/`)
}
```

Run it:

```bash
node content/pipeline/gate-descriptors.mjs
```

Expected: the three review tables, then `22 records valid — staged in
content/pipeline/records-out/`, exit 0. **Anything else means regenerating, not editing the
thresholds.** To regenerate only the records that failed, copy their lines into
`content/pipeline/descriptors-fix.jsonl` and re-run step 3.5 against that file with the
**byte-identical** instruction — same file, unedited — which is the run where the cache
pays off.

**3.7 — Review, which is a human step and the reason this is delegable at all.** The gate
proves every record is *valid*; it cannot say whether the content is any good. Read all 22
files in `content/pipeline/records-out/` — they are ~20 lines each, about 450 lines total,
which is the whole reason a 22-record batch is worth reviewing rather than writing — and
check the five things no gate can:

1. **Names.** Pronounceable, spellable, not a real or historical person, not a brand or a
   franchise character, no unfortunate reading in any obvious language, and a plausible fit
   for the archetype in the brief. This is the check that most needs a human.
2. **A racer and their kart read as one entry.** `character-3` and `kart-3` share a colour
   family and a weight; if the racer is violet and the kart is orange, the select screen
   lies about the pairing.
3. **Palettes look like linear values, not sRGB pasted in.** A "black asphalt" road at
   0.25 is an sRGB number in a linear field, and it will render as light grey. Dark surfaces
   belong at 0.02–0.08.
4. **Each theme reads as its track.** `glacier-pass` is not warm; `neon-district` is not
   bright; `caldera` is not green. And the three scenery-named tracks stay scenery-free —
   Q20 ships a ribbon, a ground plane and edge markers, so the *name* is carried entirely by
   the palette.
5. **Proportions are not comic.** Everything in range can still be a 0.4 m tall racer on a
   2.6 m kart.

Fix by regenerating the record — adjust its `brief`, never the instruction — or, for a
single number a human can obviously do better (a fog distance, one palette component), edit
the staged file and re-run the gate. Do not edit a file after it is placed in Step 3.8
without re-running the gate.

**3.8 — Place the files and document the pipeline.**

```bash
mkdir -p content/characters content/karts content/themes
for i in 0 1 2 3 4 5 6 7; do
  cp content/pipeline/records-out/character-$i.json content/characters/character-$i.json
  cp content/pipeline/records-out/kart-$i.json       content/karts/kart-$i.json
done
for t in caldera dust-canyon glacier-pass harbor-run neon-district redwood-rise; do
  cp content/pipeline/records-out/theme-$t.json content/themes/$t.json
done
ls content/characters content/karts content/themes
```

Expected: 8, 8 and 6 files. Note the rename: `theme-caldera.json` ships as
`content/themes/caldera.json`, because a theme's filename is its `trackId` and that is the
key `loadContentBundle` uses.

Then append to `content/pipeline/README.md`:

```markdown
## Descriptor and theme content

The 8 character descriptors, 8 kart descriptors and 6 track themes are generated the same
way the tracks were, with the same rule: **the gate is bundled from the real shipped code,
never rewritten.**

    npx esbuild content/pipeline/content-entry.ts --bundle --format=esm --platform=node \
      --outfile=content/pipeline/content-bundle.mjs
    deepseek-batch --jsonl content/pipeline/descriptors.jsonl --body-field brief --id-field id \
                   --instruction @content/pipeline/descriptor-gen-instruction.md \
                   --expect json --model deepseek-v4-pro --dry-run    # always dry-run first
    deepseek-batch ...                                                # drop --dry-run
    node content/pipeline/gate-descriptors.mjs                        # real parsers + roster rules

`content-bundle.mjs` is `packages/content/src/descriptors.ts` and `theme.ts` bundled by
esbuild, so a generated record is judged by the code the game runs. The gate adds the layer
a per-record parser cannot: id uniqueness, slot-letter ordering, silhouette-vs-weight
agreement, kart colour separation and edge-marker legibility — all of which need the whole
roster at once. `packages/content/test/roster.test.ts` re-asserts every one of them against
the committed files, so the invariants survive a hand edit.

Keep `descriptor-gen-instruction.md` **byte-identical** across runs; per-record detail goes
in the JSONL body. Balance is not generated: the eight stat rows come from `makeCharacters()`
via `CHARACTERS`, and the briefs hand a slot's stats to the model as input so the appearance
matches the handling.
```

Finally, do **not** commit the working files — the track pipeline left none of its own
bundles in the repository either. Append to `.gitignore` (which today is only
`node_modules/`, `dist/`, `.env`, `*.local`):

```gitignore
content/pipeline/content-bundle.mjs
content/pipeline/records-out/
content/pipeline/*.results.jsonl
```

The four authored pipeline files and the 22 records are what ship.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/content/test/roster.test.ts`

Expected: PASS — 13 passed (2 `shipped roster files` + 3 `roster ordering` + 4
`appearance agrees with the handling each slot is fixed to` + 4 `themes`).

Then confirm nothing else in the package regressed:

Run: `npx tsc --noEmit -p packages/content && npx vitest run packages/content`

Expected: no TypeScript output; every `packages/content` test green.

- [ ] **Step 5: Commit**

```bash
git add content/pipeline/content-entry.ts content/pipeline/descriptor-gen-instruction.md \
        content/pipeline/descriptors.jsonl content/pipeline/gate-descriptors.mjs \
        content/pipeline/README.md content/characters content/karts content/themes \
        packages/content/test/roster.test.ts .gitignore
git commit -m "feat(content): 8 character, 8 kart and 6 theme records, gated by the real parsers"
```
