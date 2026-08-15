// PURE (contract §0a): numbers and strings only. No DOM, no clock, no `three`.
// startShell writes these values into the DOM and makes no decision of its own.
import type { ItemKind, RacePhase } from '@tapkart/sim'
import { COUNTDOWN_TICKS, MAX_KARTS, RACE_LAPS, TICK_DT, clamp } from '@tapkart/sim'
import type { RaceView } from './types'

export type CountdownLabel = '' | '3' | '2' | '1' | 'GO'

export interface HudStanding {
  playerId: number
  place: number // 1-based
  lap: number // 1-based, clamped
  isBot: boolean
  connected: boolean
}

export interface HudModel {
  visible: boolean
  place: number // 1-BASED for display
  fieldSize: number // MAX_KARTS in v1
  lap: number // 1-BASED for display: clamp(lap + 1, 1, totalLaps)
  totalLaps: number
  speedKph: number // KartView.speed * 3.6, rounded to an integer
  item: ItemKind
  itemReady: boolean // item !== 'none' && !motionLocked
  driftTier: number // sim's encoding, copied from KartView.driftTier
  countdownLabel: CountdownLabel
  raceClock: string // formatRaceClock(max(0, tick - raceStartTick))
  respawning: boolean // respawnTicks > 0
  spunOut: boolean // spinOutTicks > 0
  /** === respawning. The HUD's throttle indicator reads THIS, not accel (Q21):
   *  adapters keep reporting the player's real input under motion lock, so
   *  `accel` says nothing about whether the kart can move. */
  motionLocked: boolean
  standings: HudStanding[] // length MAX_KARTS, sorted by place ascending
}

/** Ticks the 'GO' label stays up after `racing` begins. */
export const GO_LABEL_TICKS = 45

export function createHudModel(): HudModel {
  const standings: HudStanding[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    standings.push({ playerId: i, place: i + 1, lap: 1, isBot: true, connected: false })
  }
  return {
    visible: false,
    place: 1,
    fieldSize: MAX_KARTS,
    lap: 1,
    totalLaps: RACE_LAPS,
    speedKph: 0,
    item: 'none',
    itemReady: false,
    driftTier: -1,
    countdownLabel: '',
    raceClock: formatRaceClock(0),
    respawning: false,
    spunOut: false,
    motionLocked: false,
    standings,
  }
}

/**
 * Ticks -> "m:ss.mmm" - minutes unpadded, seconds two digits, milliseconds
 * three. formatRaceClock(0) === '0:00.000', formatRaceClock(3661) === '1:01.017'.
 * ms = Math.round(ticks * TICK_DT * 1000). Pure: no Date, no Intl.
 */
export function formatRaceClock(ticks: number): string {
  const t = Number.isFinite(ticks) && ticks > 0 ? ticks : 0
  const ms = Math.round(t * TICK_DT * 1000)
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  const millis = ms % 1000
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/**
 * '3' | '2' | '1' across COUNTDOWN_TICKS in equal thirds, 'GO' from the tick the
 * countdown expires until GO_LABEL_TICKS into the race, then ''.
 *
 * A total function of (phase, two numbers), so it is testable directly and the
 * caller cannot produce a state it has no answer for: `countdownTicksLeft` is
 * clamped into [0, COUNTDOWN_TICKS].
 */
export function countdownLabelFor(
  phase: RacePhase,
  countdownTicksLeft: number,
  ticksSinceStart: number,
): CountdownLabel {
  if (phase === 'countdown') {
    const left = clamp(countdownTicksLeft, 0, COUNTDOWN_TICKS)
    if (left > (COUNTDOWN_TICKS * 2) / 3) return '3'
    if (left > COUNTDOWN_TICKS / 3) return '2'
    if (left > 0) return '1'
    // The countdown's final tick: the lights go green here, and the label runs
    // straight on into the racing branch below with no blank frame between.
    return 'GO'
  }
  if (phase === 'racing') return ticksSinceStart < GO_LABEL_TICKS ? 'GO' : ''
  return ''
}

/**
 * SOLE WRITER of every HudModel field. `visible` is false when
 * `view.localPlayerId < 0`; everything else is read off the local seat, except
 * the fields a spectator still needs - standings, clock, countdown, field size.
 */
export function buildHudModel(view: RaceView, totalLaps: number, out: HudModel): void {
  const pid = view.localPlayerId
  const hasSeat = pid >= 0 && pid < MAX_KARTS
  const ticksSinceStart = Math.max(0, view.tick - view.raceStartTick)

  out.visible = hasSeat
  out.fieldSize = MAX_KARTS
  out.totalLaps = totalLaps
  out.countdownLabel = countdownLabelFor(view.phase, view.countdownTicksLeft, ticksSinceStart)
  out.raceClock = formatRaceClock(ticksSinceStart)

  if (hasSeat) {
    const k = view.karts[pid]
    const locked = k.respawnTicks > 0
    out.place = k.place + 1
    out.lap = clamp(k.lap + 1, 1, totalLaps)
    out.speedKph = Math.round(k.speed * 3.6)
    out.item = k.item
    out.itemReady = k.item !== 'none' && !locked
    out.driftTier = k.driftTier
    out.respawning = locked
    out.spunOut = k.spinOutTicks > 0
    out.motionLocked = locked
  } else {
    // Neutral display values: place and lap are 1-based, so 0 would render
    // "0th" and "LAP 0/3"; driftTier is sim's "no tier".
    out.place = 1
    out.lap = 1
    out.speedKph = 0
    out.item = 'none'
    out.itemReady = false
    out.driftTier = -1
    out.respawning = false
    out.spunOut = false
    out.motionLocked = false
  }

  // Standings: fill by seat, then sort by place. `view.karts` is indexed BY
  // SEAT and is not in standings order.
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = view.karts[i]
    const row = out.standings[i]
    row.playerId = k.playerId
    row.place = k.place + 1
    row.lap = clamp(k.lap + 1, 1, totalLaps)
    row.isBot = k.isBot
    row.connected = k.connected
  }
  // Insertion sort over the array's own references: 8 elements, no allocation,
  // stable, so equal places keep seat order.
  for (let i = 1; i < MAX_KARTS; i++) {
    const row = out.standings[i]
    let j = i - 1
    while (j >= 0 && out.standings[j].place > row.place) {
      out.standings[j + 1] = out.standings[j]
      j--
    }
    out.standings[j + 1] = row
  }
}
