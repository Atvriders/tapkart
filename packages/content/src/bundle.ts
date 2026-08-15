// PURE (contract §0a). Everything a race needs from shipped content in one struct
// (§3a.6): the eight character descriptors, the eight kart descriptors, and the six
// per-track themes.
//
// §3a.1: the JSON arrives by explicit static import — 22 lines below — because a
// bundler glob is a Vite-only transform and `packages/server` (Plan 4) imports this
// package under plain Node. Every record is parsed through the real parsers on first
// call, so a malformed shipped file throws at startup, loudly, rather than producing a
// half-populated bundle.
//
// Nothing in this file may name the import-meta object: bundle.test.ts asserts the
// source text never contains it, which is what stops a later tidy-up from reintroducing
// the glob — or a dev-only bundler branch — into a module the server loads.
//
// The array order below IS `characterIdx` order, and it is also `id`-ascending order —
// bundle.test.ts asserts the second, because the first cannot be asserted (nothing else
// knows which slot a record was meant for) and the two agree by construction of the
// content (Task 5).
import type { CharacterDescriptor, KartDescriptor } from './descriptors'
import { parseCharacterDescriptor, parseKartDescriptor } from './descriptors'
import type { TrackTheme } from './theme'
import { parseTrackTheme } from './theme'

import character0Json from '../../../content/characters/character-0.json' with { type: 'json' }
import character1Json from '../../../content/characters/character-1.json' with { type: 'json' }
import character2Json from '../../../content/characters/character-2.json' with { type: 'json' }
import character3Json from '../../../content/characters/character-3.json' with { type: 'json' }
import character4Json from '../../../content/characters/character-4.json' with { type: 'json' }
import character5Json from '../../../content/characters/character-5.json' with { type: 'json' }
import character6Json from '../../../content/characters/character-6.json' with { type: 'json' }
import character7Json from '../../../content/characters/character-7.json' with { type: 'json' }

import kart0Json from '../../../content/karts/kart-0.json' with { type: 'json' }
import kart1Json from '../../../content/karts/kart-1.json' with { type: 'json' }
import kart2Json from '../../../content/karts/kart-2.json' with { type: 'json' }
import kart3Json from '../../../content/karts/kart-3.json' with { type: 'json' }
import kart4Json from '../../../content/karts/kart-4.json' with { type: 'json' }
import kart5Json from '../../../content/karts/kart-5.json' with { type: 'json' }
import kart6Json from '../../../content/karts/kart-6.json' with { type: 'json' }
import kart7Json from '../../../content/karts/kart-7.json' with { type: 'json' }

import calderaThemeJson from '../../../content/themes/caldera.json' with { type: 'json' }
import dustCanyonThemeJson from '../../../content/themes/dust-canyon.json' with { type: 'json' }
import glacierPassThemeJson from '../../../content/themes/glacier-pass.json' with { type: 'json' }
import harborRunThemeJson from '../../../content/themes/harbor-run.json' with { type: 'json' }
import neonDistrictThemeJson from '../../../content/themes/neon-district.json' with { type: 'json' }
import redwoodRiseThemeJson from '../../../content/themes/redwood-rise.json' with { type: 'json' }

export interface ContentBundle {
  characters: readonly CharacterDescriptor[] // length 8, index === characterIdx
  karts: readonly KartDescriptor[] // length 8, same index space
  themes: Readonly<Record<string, TrackTheme>> // keyed by track id
}

const CHARACTER_JSON: readonly unknown[] = [
  character0Json,
  character1Json,
  character2Json,
  character3Json,
  character4Json,
  character5Json,
  character6Json,
  character7Json,
]

const KART_JSON: readonly unknown[] = [
  kart0Json,
  kart1Json,
  kart2Json,
  kart3Json,
  kart4Json,
  kart5Json,
  kart6Json,
  kart7Json,
]

/** Each theme carries the STEM OF THE FILE it came from, because the table below is the
 *  only place the filename is still known and the loader keys the map by the PARSED
 *  `trackId`. The two must agree, and `loadContentBundle` asserts it: `parseTrackTheme`
 *  checks only that `trackId` is a non-empty string, so a theme file renamed without
 *  editing its `trackId` — or a `trackId` edited without renaming the file — parses
 *  cleanly and routes silently. Keyed by filename that misroute makes `glacier-pass`
 *  render `caldera`'s palette; keyed by parsed id it leaves a track unthemed and grey.
 *  Neither fails a parser, so the disagreement is caught here instead. */
const THEME_JSON: readonly { file: string; json: unknown }[] = [
  { file: 'caldera', json: calderaThemeJson },
  { file: 'dust-canyon', json: dustCanyonThemeJson },
  { file: 'glacier-pass', json: glacierPassThemeJson },
  { file: 'harbor-run', json: harborRunThemeJson },
  { file: 'neon-district', json: neonDistrictThemeJson },
  { file: 'redwood-rise', json: redwoodRiseThemeJson },
]

/** Immutable shipped content, parsed once. Not per-race state: nothing a session owns
 *  is cached here, so this is not the module-scope hold that made `step` non-instanceable
 *  in Plan 1. */
let cached: ContentBundle | null = null

/** Parses every bundled descriptor and theme through §3a.3/§3a.4's parsers on
 *  first call and memoises. A malformed shipped file therefore throws at startup,
 *  loudly, rather than producing a half-populated bundle. */
export function loadContentBundle(): ContentBundle {
  if (cached !== null) return cached

  const characters: CharacterDescriptor[] = []
  for (let i = 0; i < CHARACTER_JSON.length; i++) {
    try {
      characters.push(parseCharacterDescriptor(CHARACTER_JSON[i]))
    } catch (e) {
      throw new Error(
        `loadContentBundle: content/characters/character-${i}.json: ${(e as Error).message}`,
      )
    }
  }

  const karts: KartDescriptor[] = []
  for (let i = 0; i < KART_JSON.length; i++) {
    try {
      karts.push(parseKartDescriptor(KART_JSON[i]))
    } catch (e) {
      throw new Error(`loadContentBundle: content/karts/kart-${i}.json: ${(e as Error).message}`)
    }
  }

  const themes: Record<string, TrackTheme> = {}
  for (const entry of THEME_JSON) {
    let theme: TrackTheme
    try {
      theme = parseTrackTheme(entry.json)
    } catch (e) {
      throw new Error(`loadContentBundle: content/themes/${entry.file}.json: ${(e as Error).message}`)
    }
    if (theme.trackId !== entry.file) {
      throw new Error(
        `loadContentBundle: content/themes/${entry.file}.json declares trackId '${theme.trackId}'; ` +
          'a theme file must be named after the track it themes',
      )
    }
    if (Object.prototype.hasOwnProperty.call(themes, theme.trackId)) {
      throw new Error(`loadContentBundle: two shipped themes claim trackId '${theme.trackId}'`)
    }
    // Keyed by the PARSED id, never by `entry.file`: `loadTrack` looks a theme up by the
    // id the track file itself declares, and the assertion above is what makes those two
    // provably the same string rather than coincidentally the same string.
    themes[theme.trackId] = theme
  }

  cached = { characters, karts, themes }
  return cached
}
