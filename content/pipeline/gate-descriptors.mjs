// Gate DeepSeek-generated descriptor and theme records with the REAL parsers from
// packages/content/src (bundled by esbuild in step 3.1, never reimplemented). A gate
// that re-implements validation tests the gate.
//
// Two layers, and the second is the one a parser cannot do: per-record shape, range and
// legibility via parseCharacterDescriptor / parseKartDescriptor / parseTrackTheme, then
// roster-wide rules — uniqueness, ordering, slot agreement and colour separation — which
// need all 22 records at once.
//
// The per-theme legibility thresholds used to live here, applied after the parse. That
// bound the generated batch and nothing else: a hand-edited theme file, or a theme from
// any other source, reached the renderer unmeasured. They are `parseTrackTheme`'s now,
// and this script does not restate them — it gets them by calling the parser, which is
// the only arrangement in which the two cannot disagree.
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

// Roster-scope only. A parser sees one record at a time and cannot compare two, so these
// two thresholds are the ones that still belong here; the per-theme ones are in
// packages/content/src/theme.ts. packages/content/test/roster.test.ts asserts both kinds
// on the committed files.
const MIN_KART_SEPARATION = 0.15
const MIN_THEME_SEPARATION = 0.1

const silhouetteFor = (w) => (w >= 1.1 ? 'wide' : w <= 0.9 ? 'compact' : 'tall')

/** Linear light crushes dark colours together; the sqrt stands in for the display
 *  transfer function, so "different" means what the eye would call different. The same
 *  space `parseTrackTheme` measures its per-record legibility in. */
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
  // Marker-pair, marker-vs-surface and road-vs-ground legibility already fired above, in
  // parseTrackTheme, and a record that broke one of them never reached this loop.
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
