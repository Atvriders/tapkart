import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { DEFAULT_TRACK_THEME } from '../src/theme'
import { TRACK_MANIFEST, loadTrack, parseTrack } from '../src/tracks'

/** Q34: tests read the real shipped files off disk with node:fs. `src` never does —
 *  it reaches them through §3a.1's static imports — and that difference is what makes
 *  these assertions evidence about shipped content rather than about a bundler. */
const TRACKS_DIR = fileURLToPath(new URL('../../../content/tracks/', import.meta.url))

function idsOnDisk(): string[] {
  return readdirSync(TRACKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort()
}

function readTrackFile(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(TRACKS_DIR, `${id}.json`), 'utf8')) as Record<string, unknown>
}

describe('TRACK_MANIFEST', () => {
  it('names exactly the files in content/tracks/', () => {
    // THE test for §3a.1's one weakness. A forgotten static import line compiles, runs,
    // and ships five tracks; this is the only thing in the repository that notices.
    //
    // It is also the tracks-side filename-vs-parsed-id check: the manifest's ids come
    // from each imported file's own `id` field, and this compares them against the
    // directory listing, so a file renamed without editing its `id` fails here.
    expect(TRACK_MANIFEST.map((e) => e.id)).toEqual(idsOnDisk())
    expect(TRACK_MANIFEST).toHaveLength(6)
  })

  it('is in menu order, which is id ascending', () => {
    const ids = TRACK_MANIFEST.map((e) => e.id)
    expect(ids).toEqual([
      'caldera',
      'dust-canyon',
      'glacier-pass',
      'harbor-run',
      'neon-district',
      'redwood-rise',
    ])
  })

  it('takes each name from the file itself, never from a hand-written table', () => {
    for (const entry of TRACK_MANIFEST) {
      expect(entry.name).toBe(readTrackFile(entry.id)['name'])
    }
  })
})

describe('loadTrack', () => {
  it('loads all six and reproduces each file exactly', () => {
    // Catches a parser that drops or renames a field — `banking` is the one that would
    // hurt most, and losing it is invisible until a mesh test on caldera fails.
    for (const entry of TRACK_MANIFEST) {
      expect(loadTrack(entry.id).track).toEqual(readTrackFile(entry.id))
    }
  })

  it('builds a usable TrackQuery for each', () => {
    for (const entry of TRACK_MANIFEST) {
      const { query } = loadTrack(entry.id)
      expect(query.totalLength()).toBeGreaterThan(100)
      expect(Number.isFinite(query.groundHeight(0, 0))).toBe(true)
      expect(query.checkpointIndexAt(0)).toBeGreaterThanOrEqual(0)
    }
  })

  it('memoises, so the arc table is built once per track per process', () => {
    const a = loadTrack('caldera')
    const b = loadTrack('caldera')
    expect(a).toBe(b)
    expect(a.query).toBe(b.query)
  })

  it('resolves each track to its own theme, not to the grey fallback', () => {
    // The bug this catches: themes keyed by anything other than trackId — a filename
    // stem, an index — collapses every lookup to DEFAULT_TRACK_THEME, and the game
    // ships six identical grey tracks with a suite that is entirely green.
    for (const entry of TRACK_MANIFEST) {
      const { theme } = loadTrack(entry.id)
      expect(theme.trackId).toBe(entry.id)
      expect(theme).not.toBe(DEFAULT_TRACK_THEME)
    }
  })

  it('throws on an unknown id, naming it', () => {
    expect(() => loadTrack('atlantis')).toThrow("loadTrack: unknown track id 'atlantis'")
  })
})

/**
 * One case per shape the parser must reject. A parser that casts its argument accepts
 * every one of these, so this table is what makes `parseTrack` more than a type
 * assertion. `mutate` edits a fresh copy of the real caldera file, so each case starts
 * from shipped, valid data and changes exactly one thing.
 */
const REJECTIONS: ReadonlyArray<{
  what: string
  mutate: (t: Record<string, unknown>) => void
  expected: string
}> = [
  { what: 'id missing', mutate: (t) => { t['id'] = undefined }, expected: 'id: must be a non-empty string, got undefined' },
  { what: 'name not a string', mutate: (t) => { t['name'] = 7 }, expected: 'name: must be a non-empty string, got 7' },
  { what: 'controlPoints missing', mutate: (t) => { t['controlPoints'] = undefined }, expected: 'controlPoints: must be an array, got undefined' },
  {
    what: 'controlPoints[0] not an object',
    mutate: (t) => { (t['controlPoints'] as unknown[])[0] = 3 },
    expected: 'controlPoints[0]: must be an object, got 3',
  },
  {
    what: 'controlPoints[0].width not a number',
    mutate: (t) => { (t['controlPoints'] as Record<string, unknown>[])[0]['width'] = 'wide' },
    expected: 'controlPoints[0].width: must be a finite number, got "wide"',
  },
  {
    what: 'controlPoints[1].banking missing',
    mutate: (t) => { (t['controlPoints'] as Record<string, unknown>[])[1]['banking'] = undefined },
    expected: 'controlPoints[1].banking: must be a finite number, got undefined',
  },
  {
    what: 'controlPoints[2].surface unknown',
    mutate: (t) => { (t['controlPoints'] as Record<string, unknown>[])[2]['surface'] = 'lava' },
    expected: 'controlPoints[2].surface: must be one of tarmac, dirt, boost, offtrack, got "lava"',
  },
  {
    what: 'controlPoints[3].position.y missing',
    mutate: (t) => {
      const p = (t['controlPoints'] as Record<string, unknown>[])[3]['position'] as Record<string, unknown>
      p['y'] = undefined
    },
    expected: 'controlPoints[3].position.y: must be a finite number, got undefined',
  },
  { what: 'checkpointS missing', mutate: (t) => { t['checkpointS'] = undefined }, expected: 'checkpointS: must be an array of numbers, got undefined' },
  {
    what: 'checkpointS[1] not a number',
    mutate: (t) => { (t['checkpointS'] as unknown[])[1] = null },
    expected: 'checkpointS[1]: must be a finite number, got null',
  },
  { what: 'itemBoxes not an array', mutate: (t) => { t['itemBoxes'] = {} }, expected: 'itemBoxes: must be an array, got an object' },
  {
    what: 'itemBoxes[0].lateral missing',
    mutate: (t) => { (t['itemBoxes'] as Record<string, unknown>[])[0]['lateral'] = undefined },
    expected: 'itemBoxes[0].lateral: must be a finite number, got undefined',
  },
  { what: 'ramps not an array', mutate: (t) => { t['ramps'] = 'none' }, expected: 'ramps: must be an array, got "none"' },
  {
    what: 'ramps[0].launch missing',
    mutate: (t) => { (t['ramps'] as Record<string, unknown>[])[0]['launch'] = undefined },
    expected: 'ramps[0].launch: must be a finite number, got undefined',
  },
  {
    what: 'boostPads[0].halfWidth not a number',
    mutate: (t) => { (t['boostPads'] as Record<string, unknown>[])[0]['halfWidth'] = '3' },
    expected: 'boostPads[0].halfWidth: must be a finite number, got "3"',
  },
  { what: 'startPositions missing', mutate: (t) => { t['startPositions'] = undefined }, expected: 'startPositions: must be an array, got undefined' },
  { what: 'bounds missing', mutate: (t) => { t['bounds'] = undefined }, expected: 'bounds: must be an object with min and max, got undefined' },
  {
    what: 'bounds.max.z missing',
    mutate: (t) => { ((t['bounds'] as Record<string, unknown>)['max'] as Record<string, unknown>)['z'] = undefined },
    expected: 'bounds.max.z: must be a finite number, got undefined',
  },
]

describe('parseTrack', () => {
  it('covers every field in the Track shape', () => {
    expect(REJECTIONS).toHaveLength(18)
  })

  for (const c of REJECTIONS) {
    it(`rejects ${c.what}`, () => {
      const raw = readTrackFile('caldera')
      c.mutate(raw)
      expect(() => parseTrack(raw)).toThrow(c.expected)
    })
  }

  it('says nothing about the fields that were fine', () => {
    // The silence guard the 18 cases above cannot supply. Each of them asserts what the
    // message MUST contain, and a parser that recited every rule in the schema on any
    // failure would satisfy all 18 while telling the author nothing about which field
    // broke. One broken field, one complaint.
    const raw = readTrackFile('caldera')
    ;(raw['controlPoints'] as Record<string, unknown>[])[0]['width'] = 'wide'
    let message = ''
    try {
      parseTrack(raw)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('controlPoints[0].width: must be a finite number, got "wide"')
    for (const silent of [
      'banking',
      'surface',
      'position',
      'checkpointS',
      'itemBoxes',
      'ramps',
      'boostPads',
      'startPositions',
      'bounds',
      'id:',
      'name:',
      'controlPoints[1]',
    ]) {
      expect(message, `complained about ${silent}, which was valid`).not.toContain(silent)
    }
  })

  it('collects every broken field into one message rather than stopping at the first', () => {
    // The other half of the same property: a parser that throws on the first bad field
    // makes fixing generated content an N-round game. Both complaints, one throw.
    const raw = readTrackFile('caldera')
    ;(raw['controlPoints'] as Record<string, unknown>[])[0]['width'] = 'wide'
    ;(raw['bounds'] as Record<string, unknown>)['max'] = undefined
    let message = ''
    try {
      parseTrack(raw)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('controlPoints[0].width: must be a finite number, got "wide"')
    expect(message).toContain('bounds.max: must be an object with x, y and z, got undefined')
    expect(message).toContain('; ')
  })

  it('rejects a non-object outright', () => {
    expect(() => parseTrack(null)).toThrow('parseTrack: must be an object, got null')
    expect(() => parseTrack([])).toThrow('parseTrack: must be an object, got an array of 0')
  })

  it('runs sim\'s real validateTrack, not just a shape check', () => {
    // The defect this catches is the one that matters: a parser that type-checks a
    // generated track and never asks whether `s` is in [0,1) accepts a track whose
    // checkpoints are in metres — which is the single most common way this project's
    // generated content has been wrong.
    const raw = readTrackFile('caldera')
    ;(raw['checkpointS'] as number[])[0] = 5
    expect(() => parseTrack(raw)).toThrow('checkpointS[0]: must be within 0..1, got 5')
  })

  it('returns a copy, so a caller cannot mutate the imported JSON module', () => {
    const raw = readTrackFile('caldera')
    const track = parseTrack(raw)
    ;(raw['controlPoints'] as Record<string, unknown>[])[0]['width'] = 999
    expect(track.controlPoints[0].width).not.toBe(999)
  })
})
