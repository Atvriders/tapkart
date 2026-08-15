// Second-stage gate for generated tracks: builds the REAL TrackQuery from
// packages/sim/src/track.ts and probes geometric properties that the static
// validateTrack cannot see. Still not drivability — that is Task 14's bot test.
import { readFileSync, readdirSync } from 'node:fs'
import { validateTrack, buildTrackQuery } from './track-validator.mjs'

const dir = process.argv[2] ?? './tracks-out'
const N = 720 // centreline probes per track

let allPass = true

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const track = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'))
  const problems = []

  const staticErrs = validateTrack(track)
  if (staticErrs.length) problems.push(`static: ${staticErrs.length} error(s)`)

  const q = buildTrackQuery(track)
  const L = q.totalLength()

  // Control-polygon length, the chord-wise lower bound on true arc length.
  let poly = 0
  const cps = track.controlPoints
  for (let i = 0; i < cps.length; i++) {
    const a = cps[i].position
    const b = cps[(i + 1) % cps.length].position
    poly += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  }
  // A Catmull-Rom through the points is at least as long as the chords, and
  // wildly longer means the spline is looping between control points.
  const ratio = L / poly
  if (ratio < 0.98 || ratio > 1.15) {
    problems.push(`arc/polygon ratio ${ratio.toFixed(4)} outside [0.98, 1.15]`)
  }

  // Round-trip: project the centreline back onto itself. On a clean loop this
  // returns the same s with ~0 lateral. Where the track passes near itself, the
  // nearest-point search snaps to the other branch and s jumps — which is how a
  // self-intersection shows up without writing a segment-intersection test.
  let worstDs = 0
  let worstAt = 0
  let worstLat = 0
  for (let i = 0; i < N; i++) {
    const s = i / N
    const p = q.sampleAt(s).position
    const pos = { x: p.x, y: p.y, z: p.z } // sampleAt returns shared scratch
    const proj = q.project(pos)
    let ds = Math.abs(proj.s - s)
    if (ds > 0.5) ds = 1 - ds
    if (ds > worstDs) {
      worstDs = ds
      worstAt = s
    }
    if (Math.abs(proj.lateral) > Math.abs(worstLat)) worstLat = proj.lateral
  }
  const worstMetres = worstDs * L
  if (worstMetres > 5) {
    problems.push(
      `centreline round-trip off by ${worstMetres.toFixed(1)} m at s=${worstAt.toFixed(3)} ` +
        `(likely self-intersection or near-touch)`,
    )
  }
  if (Math.abs(worstLat) > 0.5) {
    problems.push(`centreline projects to lateral ${worstLat.toFixed(3)}, expected ~0`)
  }

  // Self-intersection / near-touch, checked properly.
  //
  // The round-trip probe above CANNOT find this: a point sampled exactly on the
  // centreline sits at distance 0 from its own branch, so the nearest-point search
  // always returns that branch no matter what else crosses nearby. The real test is
  // whether two parts of the loop that are far apart ALONG the track are close
  // together IN SPACE — and closer than their two half-widths means the drivable
  // surfaces physically overlap.
  const pts = []
  for (let i = 0; i < N; i++) {
    const s = i / N
    const sp = q.sampleAt(s)
    pts.push({ s, x: sp.position.x, z: sp.position.z, half: sp.width / 2 })
  }
  let worstOverlap = 0
  let overlapAt = null
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      let ds = Math.abs(pts[i].s - pts[j].s)
      if (ds > 0.5) ds = 1 - ds
      if (ds * L < 60) continue // adjacent along the track; of course they are close
      const gap = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z)
      const need = pts[i].half + pts[j].half
      if (need - gap > worstOverlap) {
        worstOverlap = need - gap
        overlapAt = [pts[i].s, pts[j].s, gap, need]
      }
    }
  }
  if (worstOverlap > 0) {
    const [sa, sb, gap, need] = overlapAt
    problems.push(
      `surfaces overlap: s=${sa.toFixed(3)} and s=${sb.toFixed(3)} are ${gap.toFixed(1)} m apart ` +
        `but need ${need.toFixed(1)} m (overlap ${worstOverlap.toFixed(1)} m)`,
    )
  }

  // The centreline itself must be in bounds and on a real surface everywhere.
  let offtrack = 0
  let oob = 0
  for (let i = 0; i < N; i++) {
    const s = i / N
    if (q.surfaceAt(s, 0) === 'offtrack') offtrack++
    if (!q.isInBounds(s, 0)) oob++
  }
  if (offtrack) problems.push(`${offtrack}/${N} centreline samples report surface 'offtrack'`)
  if (oob) problems.push(`${oob}/${N} centreline samples report out of bounds`)

  // Checkpoint ring must be reachable in order and cover the whole lap.
  const seen = new Set()
  for (let i = 0; i < N; i++) seen.add(q.checkpointIndexAt(i / N))
  if (seen.size !== track.checkpointS.length) {
    problems.push(
      `checkpointIndexAt reaches ${seen.size} of ${track.checkpointS.length} checkpoints ` +
        `(one is too short to be sampled)`,
    )
  }

  const id = file.replace(/\.json$/, '')
  if (problems.length === 0) {
    console.log(
      `${id.padEnd(15)} PASS  ${L.toFixed(0).padStart(5)} m  arc/poly ${ratio.toFixed(3)}  ` +
        `proj err ${worstMetres.toFixed(2)} m  no overlap  ${seen.size} checkpoints`,
    )
  } else {
    allPass = false
    console.log(`${id.padEnd(15)} FAIL`)
    for (const p of problems) console.log(`                - ${p}`)
  }
}

console.log(allPass ? '\nall tracks pass the query-level gate' : '\nsome tracks failed')
