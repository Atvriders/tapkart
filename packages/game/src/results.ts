import { FINISH_GRACE_TICKS, RACE_LAPS } from '@tapkart/sim'
import type { KartView, RaceView } from '@tapkart/render'
import { loadContentBundle } from '@tapkart/content'
import type { LobbySlot } from './app'

export interface ResultRow {
  place: number
  playerId: number
  name: string
  dnf: boolean
}

/** A kart is DNF only when the race ended at grace expiry and it is short of
 * the required lap count. */
export function isDnf(view: RaceView, kart: KartView): boolean {
  const gracedOut =
    view.phase === 'finished' &&
    view.finishTick >= 0 &&
    view.tick - view.finishTick >= FINISH_GRACE_TICKS
  return gracedOut && kart.lap < RACE_LAPS
}

/** Builds position-only authoritative rows in the simulation's finishing order. */
export function buildResultRows(view: RaceView, slots: readonly LobbySlot[]): ResultRow[] {
  const rows: ResultRow[] = []
  const descriptors = loadContentBundle().characters

  for (let i = 0; i < view.finishedOrder.length; i++) {
    const playerId = view.finishedOrder[i]
    if (playerId < 0 || playerId >= view.karts.length) continue
    const kart = view.karts[playerId]

    let name = ''
    for (let s = 0; s < slots.length; s++) {
      if (slots[s].playerId === playerId) {
        name = slots[s].name
        break
      }
    }
    if (name === '') {
      const idx = kart.characterIdx
      name = idx >= 0 && idx < descriptors.length
        ? descriptors[idx].name
        : 'Player ' + (playerId + 1)
    }

    rows.push({
      place: rows.length + 1,
      playerId,
      name,
      dnf: isDnf(view, kart),
    })
  }
  return rows
}
