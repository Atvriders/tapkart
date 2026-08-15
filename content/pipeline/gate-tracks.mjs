// Gate DeepSeek-generated track JSON with the REAL validateTrack from
// packages/sim/src/track.ts (bundled by esbuild, not reimplemented).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { validateTrack } from './track-validator.mjs'

const resultsPath = process.argv[2] ?? './tracks.jsonl.results.jsonl'
const outDir = './tracks-out'
mkdirSync(outDir, { recursive: true })

const lines = readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean)

let pass = 0
let fail = 0

for (const line of lines) {
  const rec = JSON.parse(line)
  if (!rec.ok) {
    console.log(`\n=== ${rec.id} === API ERROR: ${rec.error}`)
    fail++
    continue
  }

  let track
  try {
    track = JSON.parse(rec.content)
  } catch (e) {
    console.log(`\n=== ${rec.id} === NOT JSON: ${e.message}`)
    fail++
    continue
  }

  const errs = validateTrack(track)
  const cps = track.controlPoints ?? []

  // Closed control-polygon length, the same quantity validateTrack uses internally.
  let L = 0
  for (let i = 0; i < cps.length; i++) {
    const a = cps[i].position
    const b = cps[(i + 1) % cps.length].position
    L += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  }

  const ys = cps.map((c) => c.position.y)
  const ws = cps.map((c) => c.width)
  const surfaces = [...new Set(cps.map((c) => c.surface))]

  console.log(`\n=== ${rec.id} === ${errs.length === 0 ? 'VALID' : `${errs.length} ERROR(S)`}`)
  console.log(
    `  ${cps.length} control points · length ${L.toFixed(1)} m · ` +
      `width ${Math.min(...ws)}-${Math.max(...ws)} m · ` +
      `elevation ${Math.min(...ys).toFixed(1)}..${Math.max(...ys).toFixed(1)} m`,
  )
  console.log(
    `  ${track.checkpointS?.length ?? 0} checkpoints · ${track.itemBoxes?.length ?? 0} item boxes · ` +
      `${track.ramps?.length ?? 0} ramps · ${track.boostPads?.length ?? 0} boost pads · ` +
      `surfaces [${surfaces.join(', ')}]`,
  )

  if (errs.length) {
    for (const e of errs.slice(0, 12)) console.log(`  - ${e}`)
    if (errs.length > 12) console.log(`  ... and ${errs.length - 12} more`)
    fail++
  } else {
    writeFileSync(`${outDir}/${rec.id}.json`, JSON.stringify(track, null, 2) + '\n')
    pass++
  }
}

console.log(`\n${pass} valid, ${fail} rejected (of ${lines.length}) — valid tracks in ${outDir}/`)
