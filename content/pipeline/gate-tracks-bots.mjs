// Stage 3 gate: the design spec's real drivability test —
//   "Bot-drivability: a bot completes 3 laps with zero respawns."
// Drives the REAL bots through the REAL step() on each generated track.
import { readFileSync, readdirSync } from 'node:fs'
import { buildTrackQuery, validateTrack, createState, step } from './sim-bundle.mjs'

// Locked contract §3 values. Transcribed, not invented — these are the same
// numbers packages/sim/test/fixtures/track-fixtures.ts uses.
const TUNING = {
  maxSpeed: 40, accelRate: 24, brakeRate: 48,
  steerRateBase: 2.6, steerSpeedFalloff: 0.55,
  gripTarmac: 14, gripDirt: 5, gripDrift: 3,
  gravity: 30, airYaw: 0.6, offtrackSpeedMul: 0.55,
  respawnTicks: 72, invulnTicks: 90, spinOutTicks: 60,
  driftMinSpeed: 8, driftTiers: [40, 90, 150], driftBoosts: [24, 42, 66],
  boostSpeedMul: 1.35, surgeSpeedMul: 0.7,
  kartRadius: 0.9, kartRestitution: 0.4,
  itemBoxRespawnTicks: 180, seekerSpeed: 55, boltSpeed: 65, entityTtl: 600,
}
const SPEED = [1.0, 1.1, 0.92, 1.05, 0.95, 1.15, 0.88, 1.0]
const ACCEL = [1.0, 0.85, 1.15, 0.9, 1.1, 0.8, 1.2, 1.0]
const HANDLING = [1.0, 0.9, 1.1, 0.95, 1.05, 0.85, 1.15, 1.0]
const WEIGHT = [1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0]
const CHARACTERS = Array.from({ length: 8 }, (_, i) => ({
  id: `c${i}`, name: `C${i}`,
  speed: SPEED[i], accel: ACCEL[i], handling: HANDLING[i], weight: WEIGHT[i],
}))

const COUNTDOWN_TICKS = 180
const RACE_LAPS = 3
const MAX_TICKS = 40000 // ~11 min of race time; 3 laps needs far less

const dir = process.argv[2] ?? './tracks-out'
let allPass = true

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const id = file.replace(/\.json$/, '')
  const track = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'))

  const staticErrs = validateTrack(track)
  if (staticErrs.length) {
    console.log(`${id.padEnd(15)} FAIL  static validator: ${staticErrs[0]}`)
    allPass = false
    continue
  }

  const ctx = {
    track,
    query: buildTrackQuery(track),
    tuning: TUNING,
    characters: CHARACTERS,
    isLeader: true,
  }
  const characterIdx = [0, 1, 2, 3, 4, 5, 6, 7]
  let a = createState(ctx, 12345, characterIdx)
  let b = createState(ctx, 12345, characterIdx)

  const respawns = new Array(8).fill(0)
  const offtrackTicks = new Array(8).fill(0)
  let prevRespawnTicks = a.karts.map((k) => k.respawnTicks)
  let finishedTick = -1
  let t = 0

  for (; t < MAX_TICKS; t++) {
    step(ctx, a, b, [], [])
    const tmp = a; a = b; b = tmp

    for (let i = 0; i < 8; i++) {
      const k = a.karts[i]
      // A respawn STARTS on the tick respawnTicks goes 0 -> positive.
      if (prevRespawnTicks[i] === 0 && k.respawnTicks > 0) respawns[i]++
      prevRespawnTicks[i] = k.respawnTicks
      if (k.surface === 'offtrack') offtrackTicks[i]++
    }
    if (a.karts.every((k) => k.lap.lap >= RACE_LAPS)) { finishedTick = t; break }
  }

  const laps = a.karts.map((k) => k.lap.lap)
  const totalRespawns = respawns.reduce((x, y) => x + y, 0)
  const worstOfftrack = Math.max(...offtrackTicks)
  const allFinished = laps.every((l) => l >= RACE_LAPS)
  const raceTicks = finishedTick >= 0 ? finishedTick - COUNTDOWN_TICKS : t
  const pass = allFinished && totalRespawns === 0

  if (pass) {
    console.log(
      `${id.padEnd(15)} PASS  8/8 bots finished ${RACE_LAPS} laps in ` +
        `${(raceTicks / 60).toFixed(1)}s  0 respawns  worst off-track ${worstOfftrack} ticks`,
    )
  } else {
    allPass = false
    console.log(`${id.padEnd(15)} FAIL`)
    console.log(`                - laps per bot: [${laps.join(', ')}] (need ${RACE_LAPS})`)
    console.log(`                - respawns per bot: [${respawns.join(', ')}] (need all 0)`)
    console.log(`                - off-track ticks: [${offtrackTicks.join(', ')}]`)
    console.log(`                - ran ${t} ticks (${(t / 60).toFixed(1)}s)`)
  }
}

console.log(
  allPass
    ? '\nall tracks pass the bot-drivability gate'
    : '\nsome tracks are not bot-drivable — first-draft geometry needs tuning',
)
