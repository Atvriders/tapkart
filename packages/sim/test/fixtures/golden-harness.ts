// Runs a recorded intent stream through step() and compares the resulting SimState to a stored
// expectation field by field: exact for integers, enums and booleans, per-field tolerance for the
// continuous ones. Every difference carries its path, both values, the delta and the tolerance -
// which is precisely what a digest cannot do.
import type {
  AuthEvent,
  EntityState,
  Intent,
  KartState,
  SimContext,
  SimState,
  Vec3,
} from '../../src/types'
import { MAX_ENTITIES, MAX_KARTS, RACE_LAPS } from '../../src/types'
import { wrapAngle } from '../../src/mathutil'
import { createState } from '../../src/state'
import { step } from '../../src/step'
import { botIntent } from '../../src/bot'
import type {
  FieldDiff,
  GoldenEntity,
  GoldenEventSummary,
  GoldenExpectation,
  GoldenFixture,
  GoldenKart,
  GoldenTolerance,
} from './golden-format'
import {
  GOLDEN_TAIL_TICKS,
  GOLDEN_TOL,
  decodeB64Lines,
  normZero,
  quantizeIntent,
  unpackIntents,
} from './golden-format'

export interface GoldenRun {
  end: SimState
  events: AuthEvent[]
  ticks: number
}

export interface DrivabilityReport {
  respawnCount: number
  finishedPlayerIds: number[]
  lapsByPlayer: number[]
  allFinished: boolean
  ok: boolean
}

/**
 * The golden start state. Every kart is marked connected and not a bot, so at replay time the
 * recorded stream is the only input source and no bot fill can run. The stream itself was authored
 * by botIntent at regeneration time, which is what makes replaying it a test of the bot's line.
 */
export function makeGoldenState(ctx: SimContext, seed: number, characterIdx: number[]): SimState {
  const s = createState(ctx, seed, characterIdx)
  for (let i = 0; i < MAX_KARTS; i++) {
    s.karts[i].isBot = false
    s.karts[i].connected = true
  }
  return s
}

/** Runs exactly `ticks` ticks, double-buffered, accumulating every emitted event. */
export function runGoldenTicks(
  ctx: SimContext,
  seed: number,
  characterIdx: number[],
  intents: Intent[][],
  ticks: number,
): GoldenRun {
  if (intents.length < ticks) {
    throw new Error(`golden: intent stream has ${intents.length} rows, need ${ticks}`)
  }
  let cur = makeGoldenState(ctx, seed, characterIdx)
  let nxt = makeGoldenState(ctx, seed, characterIdx)
  const events: AuthEvent[] = []
  for (let t = 0; t < ticks; t++) {
    if (cur.tick !== t) {
      throw new Error(`golden: state is at tick ${cur.tick} while replaying row ${t}`)
    }
    step(ctx, cur, nxt, intents[t], events)
    const tmp = cur
    cur = nxt
    nxt = tmp
  }
  return { end: cur, events, ticks }
}

export function replayGoldenFixture(ctx: SimContext, fx: GoldenFixture): GoldenRun {
  const intents = unpackIntents(decodeB64Lines(fx.intentsB64), fx.tickCount)
  return runGoldenTicks(ctx, fx.raceSeed, fx.characterIdx, intents, fx.tickCount)
}

/**
 * Drives all eight karts with botIntent and records the resulting stream. Stops
 * GOLDEN_TAIL_TICKS after the last kart's finish event, or at maxTicks.
 *
 * Bots recompute an Intent only on even ticks and reuse it on odd ticks, per the contract's
 * 30Hz-input-against-a-60Hz-sim convention.
 */
export function recordGoldenWithBots(
  ctx: SimContext,
  seed: number,
  characterIdx: number[],
  maxTicks: number,
): { run: GoldenRun; intents: Intent[][] } {
  let cur = makeGoldenState(ctx, seed, characterIdx)
  let nxt = makeGoldenState(ctx, seed, characterIdx)
  const events: AuthEvent[] = []
  const intents: Intent[][] = []
  const held: Intent[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    held.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  const finished = new Set<number>()
  let allFinishedAt = -1
  let ticks = 0

  while (ticks < maxTicks) {
    if (cur.tick !== ticks) {
      throw new Error(`golden: state is at tick ${cur.tick} while recording row ${ticks}`)
    }
    const row: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      if (cur.tick % 2 === 0) {
        const raw = botIntent(ctx, cur, i)
        held[i].steer = raw.steer
        held[i].accel = raw.accel
        held[i].brake = raw.brake
        held[i].drift = raw.drift
        held[i].useItem = raw.useItem
      }
      row.push(quantizeIntent(held[i], cur.tick))
    }
    intents.push(row)

    const before = events.length
    step(ctx, cur, nxt, row, events)
    const tmp = cur
    cur = nxt
    nxt = tmp
    ticks++

    for (let e = before; e < events.length; e++) {
      // playerId >= 0 only: updatePhase's race-level 'finish' carries -1.
      if (events[e].kind === 'finish' && events[e].playerId >= 0) finished.add(events[e].playerId)
    }
    if (allFinishedAt < 0 && finished.size >= MAX_KARTS) allFinishedAt = ticks
    if (allFinishedAt >= 0 && ticks >= allFinishedAt + GOLDEN_TAIL_TICKS) break
  }

  return { run: { end: cur, events, ticks }, intents }
}

function assertFinite(path: string, v: number): number {
  if (!Number.isFinite(v)) {
    throw new Error(`golden: ${path} is not finite (${v}); refusing to store it`)
  }
  return normZero(v)
}

function vec(path: string, v: Vec3): [number, number, number] {
  return [
    assertFinite(`${path}.x`, v.x),
    assertFinite(`${path}.y`, v.y),
    assertFinite(`${path}.z`, v.z),
  ]
}

export function toExpectation(state: SimState): GoldenExpectation {
  const karts: GoldenKart[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = state.karts[i]
    karts.push({
      playerId: k.playerId,
      characterIdx: k.characterIdx,
      isBot: k.isBot,
      connected: k.connected,
      position: vec(`karts[${i}].position`, k.position),
      velocity: vec(`karts[${i}].velocity`, k.velocity),
      heading: assertFinite(`karts[${i}].heading`, k.heading),
      angularVelocity: assertFinite(`karts[${i}].angularVelocity`, k.angularVelocity),
      drift: {
        active: k.drift.active,
        dir: k.drift.dir,
        charge: assertFinite(`karts[${i}].drift.charge`, k.drift.charge),
      },
      item: k.item,
      airborne: k.airborne,
      surface: k.surface,
      spinOutTicks: k.spinOutTicks,
      invulnTicks: k.invulnTicks,
      boostTicks: k.boostTicks,
      respawnTicks: k.respawnTicks,
      shielded: k.shielded,
      lap: {
        lap: k.lap.lap,
        checkpointIdx: k.lap.checkpointIdx,
        t: assertFinite(`karts[${i}].lap.t`, k.lap.t),
      },
    })
  }

  const entities: GoldenEntity[] = []
  for (let i = 0; i < state.entityCount; i++) {
    const e = state.entities[i]
    entities.push({
      entityId: e.entityId,
      kind: e.kind,
      ownerId: e.ownerId,
      position: vec(`entities[${i}].position`, e.position),
      velocity: vec(`entities[${i}].velocity`, e.velocity),
      heading: assertFinite(`entities[${i}].heading`, e.heading),
      targetId: e.targetId,
      ttl: e.ttl,
    })
  }

  return {
    tick: state.tick,
    phase: state.phase,
    raceSeed: state.raceSeed,
    rngCursor: state.rngCursor,
    nextEventSeq: state.nextEventSeq,
    finishTick: state.finishTick,
    entityCount: state.entityCount,
    nextEntityId: state.nextEntityId,
    finishedOrder: state.finishedOrder.slice(),
    itemBoxes: state.itemBoxes.map((b) => ({ boxIdx: b.boxIdx, respawnTicks: b.respawnTicks })),
    karts,
    entities,
  }
}

function exact(
  out: FieldDiff[],
  path: string,
  expected: number | string | boolean,
  actual: number | string | boolean,
): void {
  const e = typeof expected === 'number' ? normZero(expected) : expected
  const a = typeof actual === 'number' ? normZero(actual) : actual
  if (Object.is(e, a)) return
  const delta = typeof e === 'number' && typeof a === 'number' ? a - e : Number.NaN
  out.push({ path, expected, actual, delta, tolerance: 0 })
}

function approx(
  out: FieldDiff[],
  path: string,
  expected: number,
  actual: number,
  tolerance: number,
): void {
  const delta = actual - expected
  // Written as a negated <= so a NaN actual is always reported.
  if (Math.abs(delta) <= tolerance) return
  out.push({ path, expected, actual, delta, tolerance })
}

/** Headings are compared as angles: the shortest signed difference, wrapped to (-PI, PI]. */
function approxAngle(
  out: FieldDiff[],
  path: string,
  expected: number,
  actual: number,
  tolerance: number,
): void {
  const delta = wrapAngle(actual - expected)
  if (Math.abs(delta) <= tolerance) return
  out.push({ path, expected, actual, delta, tolerance })
}

/** Every stored heading must already be wrapped; an unwrapped one is a contract violation. */
function checkWrapped(out: FieldDiff[], path: string, actual: number): void {
  if (actual > -Math.PI && actual <= Math.PI) return
  out.push({
    path: `${path}[wrapped]`,
    expected: '(-PI, PI]',
    actual,
    delta: Number.NaN,
    tolerance: 0,
  })
}

function diffKart(
  out: FieldDiff[],
  i: number,
  e: GoldenKart,
  a: KartState,
  tol: GoldenTolerance,
): void {
  const p = `karts[${i}]`
  exact(out, `${p}.playerId`, e.playerId, a.playerId)
  exact(out, `${p}.characterIdx`, e.characterIdx, a.characterIdx)
  exact(out, `${p}.isBot`, e.isBot, a.isBot)
  exact(out, `${p}.connected`, e.connected, a.connected)
  approx(out, `${p}.position.x`, e.position[0], a.position.x, tol.position)
  approx(out, `${p}.position.y`, e.position[1], a.position.y, tol.position)
  approx(out, `${p}.position.z`, e.position[2], a.position.z, tol.position)
  approx(out, `${p}.velocity.x`, e.velocity[0], a.velocity.x, tol.velocity)
  approx(out, `${p}.velocity.y`, e.velocity[1], a.velocity.y, tol.velocity)
  approx(out, `${p}.velocity.z`, e.velocity[2], a.velocity.z, tol.velocity)
  approxAngle(out, `${p}.heading`, e.heading, a.heading, tol.heading)
  checkWrapped(out, `${p}.heading`, a.heading)
  approx(out, `${p}.angularVelocity`, e.angularVelocity, a.angularVelocity, tol.angularVelocity)
  exact(out, `${p}.drift.active`, e.drift.active, a.drift.active)
  exact(out, `${p}.drift.dir`, e.drift.dir, a.drift.dir)
  approx(out, `${p}.drift.charge`, e.drift.charge, a.drift.charge, tol.driftCharge)
  exact(out, `${p}.item`, e.item, a.item)
  exact(out, `${p}.airborne`, e.airborne, a.airborne)
  exact(out, `${p}.surface`, e.surface, a.surface)
  exact(out, `${p}.spinOutTicks`, e.spinOutTicks, a.spinOutTicks)
  exact(out, `${p}.invulnTicks`, e.invulnTicks, a.invulnTicks)
  exact(out, `${p}.boostTicks`, e.boostTicks, a.boostTicks)
  exact(out, `${p}.respawnTicks`, e.respawnTicks, a.respawnTicks)
  exact(out, `${p}.shielded`, e.shielded, a.shielded)
  exact(out, `${p}.lap.lap`, e.lap.lap, a.lap.lap)
  exact(out, `${p}.lap.checkpointIdx`, e.lap.checkpointIdx, a.lap.checkpointIdx)
  approx(out, `${p}.lap.t`, e.lap.t, a.lap.t, tol.lapT)
}

function diffEntity(
  out: FieldDiff[],
  i: number,
  e: GoldenEntity,
  a: EntityState,
  tol: GoldenTolerance,
): void {
  const p = `entities[${i}]`
  exact(out, `${p}.entityId`, e.entityId, a.entityId)
  exact(out, `${p}.kind`, e.kind, a.kind)
  exact(out, `${p}.ownerId`, e.ownerId, a.ownerId)
  approx(out, `${p}.position.x`, e.position[0], a.position.x, tol.position)
  approx(out, `${p}.position.y`, e.position[1], a.position.y, tol.position)
  approx(out, `${p}.position.z`, e.position[2], a.position.z, tol.position)
  approx(out, `${p}.velocity.x`, e.velocity[0], a.velocity.x, tol.velocity)
  approx(out, `${p}.velocity.y`, e.velocity[1], a.velocity.y, tol.velocity)
  approx(out, `${p}.velocity.z`, e.velocity[2], a.velocity.z, tol.velocity)
  approxAngle(out, `${p}.heading`, e.heading, a.heading, tol.heading)
  checkWrapped(out, `${p}.heading`, a.heading)
  exact(out, `${p}.targetId`, e.targetId, a.targetId)
  exact(out, `${p}.ttl`, e.ttl, a.ttl)
}

export function diffAgainstGolden(
  exp: GoldenExpectation,
  act: SimState,
  tol: GoldenTolerance = GOLDEN_TOL,
): FieldDiff[] {
  const out: FieldDiff[] = []

  exact(out, 'tick', exp.tick, act.tick)
  exact(out, 'phase', exp.phase, act.phase)
  exact(out, 'raceSeed', exp.raceSeed, act.raceSeed)
  exact(out, 'rngCursor', exp.rngCursor, act.rngCursor)
  exact(out, 'nextEventSeq', exp.nextEventSeq, act.nextEventSeq)
  exact(out, 'finishTick', exp.finishTick, act.finishTick)
  exact(out, 'entityCount', exp.entityCount, act.entityCount)
  exact(out, 'nextEntityId', exp.nextEntityId, act.nextEntityId)
  exact(out, 'karts.length', MAX_KARTS, act.karts.length)
  exact(out, 'entities.length', MAX_ENTITIES, act.entities.length)

  exact(out, 'finishedOrder.length', exp.finishedOrder.length, act.finishedOrder.length)
  const nOrder = Math.min(exp.finishedOrder.length, act.finishedOrder.length)
  for (let i = 0; i < nOrder; i++) {
    exact(out, `finishedOrder[${i}]`, exp.finishedOrder[i], act.finishedOrder[i])
  }

  exact(out, 'itemBoxes.length', exp.itemBoxes.length, act.itemBoxes.length)
  const nBox = Math.min(exp.itemBoxes.length, act.itemBoxes.length)
  for (let i = 0; i < nBox; i++) {
    exact(out, `itemBoxes[${i}].boxIdx`, exp.itemBoxes[i].boxIdx, act.itemBoxes[i].boxIdx)
    exact(
      out,
      `itemBoxes[${i}].respawnTicks`,
      exp.itemBoxes[i].respawnTicks,
      act.itemBoxes[i].respawnTicks,
    )
  }

  const nKart = Math.min(MAX_KARTS, act.karts.length, exp.karts.length)
  for (let i = 0; i < nKart; i++) diffKart(out, i, exp.karts[i], act.karts[i], tol)

  const nLive = Math.min(exp.entityCount, exp.entities.length, act.entities.length)
  for (let i = 0; i < nLive; i++) diffEntity(out, i, exp.entities[i], act.entities[i], tol)
  // Live entities are packed at the front, so every slot past entityCount holds the dead sentinel.
  for (let i = exp.entityCount; i < act.entities.length; i++) {
    exact(out, `entities[${i}].entityId`, -1, act.entities[i].entityId)
  }

  return out
}

export function summarizeEvents(events: AuthEvent[]): GoldenEventSummary {
  const countsByKind: Record<string, number> = {
    itemGrant: 0,
    entitySpawn: 0,
    entityDespawn: 0,
    hit: 0,
    spinOut: 0,
    respawn: 0,
    lapCross: 0,
    finish: 0,
  }
  const finishes: { playerId: number; tick: number }[] = []
  for (const e of events) {
    countsByKind[e.kind] = (countsByKind[e.kind] ?? 0) + 1
    // Every event counts toward countsByKind, including updatePhase's race-level 'finish'
    // (playerId -1). `finishes` is the per-kart finishing ORDER, so it takes playerId >= 0 only.
    if (e.kind === 'finish' && e.playerId >= 0) finishes.push({ playerId: e.playerId, tick: e.tick })
  }
  return { total: events.length, countsByKind, finishes }
}

export function diffEventSummary(
  exp: GoldenEventSummary,
  act: GoldenEventSummary,
): FieldDiff[] {
  const out: FieldDiff[] = []
  exact(out, 'events.total', exp.total, act.total)
  const kinds = Object.keys(exp.countsByKind).sort()
  for (const kind of kinds) {
    exact(out, `events.countsByKind.${kind}`, exp.countsByKind[kind], act.countsByKind[kind] ?? -1)
  }
  exact(out, 'events.finishes.length', exp.finishes.length, act.finishes.length)
  const n = Math.min(exp.finishes.length, act.finishes.length)
  for (let i = 0; i < n; i++) {
    exact(out, `events.finishes[${i}].playerId`, exp.finishes[i].playerId, act.finishes[i].playerId)
    exact(out, `events.finishes[${i}].tick`, exp.finishes[i].tick, act.finishes[i].tick)
  }
  return out
}

/**
 * The spec's bot-drivability criterion: every kart finishes RACE_LAPS laps, with zero respawns.
 *
 * updatePhase [Task 15] emits ONE race-level 'finish' event with playerId -1 when the race ends,
 * on top of the per-kart 'finish' events updateLaps [Task 11] emits. Counting that one as a
 * finisher would make finishedPlayerIds nine entries long and allFinished permanently false, so
 * finishers are collected from playerId >= 0 only.
 */
export function checkDrivability(state: SimState, events: AuthEvent[]): DrivabilityReport {
  let respawnCount = 0
  const finished = new Set<number>()
  for (const e of events) {
    if (e.kind === 'respawn') respawnCount++
    else if (e.kind === 'finish' && e.playerId >= 0) finished.add(e.playerId)
  }
  const finishedPlayerIds = Array.from(finished).sort((a, b) => a - b)
  const lapsByPlayer: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) lapsByPlayer.push(state.karts[i].lap.lap)
  const allFinished =
    finishedPlayerIds.length === MAX_KARTS && lapsByPlayer.every((l) => l >= RACE_LAPS)
  return { respawnCount, finishedPlayerIds, lapsByPlayer, allFinished, ok: allFinished && respawnCount === 0 }
}

export function describeDrivabilityFailure(d: DrivabilityReport): string {
  const missing: string[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    if (!d.finishedPlayerIds.includes(i)) missing.push(`player ${i} (lap ${d.lapsByPlayer[i]})`)
  }
  return (
    `golden: bot-drivability failed. respawn events: ${d.respawnCount} (must be 0); ` +
    `karts that did not finish ${RACE_LAPS} laps: ${missing.length === 0 ? 'none' : missing.join(', ')}; ` +
    `laps by player: [${d.lapsByPlayer.join(', ')}]`
  )
}

function fmtValue(v: number | string | boolean): string {
  if (typeof v !== 'number') return JSON.stringify(v)
  return Number.isInteger(v) ? String(v) : v.toPrecision(12)
}

export function formatDiffs(diffs: FieldDiff[]): string {
  if (diffs.length === 0) return ''
  const lines = diffs.map(
    (d) =>
      `${d.path}: expected ${fmtValue(d.expected)}, actual ${fmtValue(d.actual)}, ` +
      `delta ${Number.isNaN(d.delta) ? 'n/a' : d.delta.toExponential(3)}, ` +
      `tolerance ${d.tolerance === 0 ? 'exact' : d.tolerance.toExponential(0)}`,
  )
  return `${diffs.length} field(s) differ from the golden fixture:\n  ${lines.join('\n  ')}`
}
