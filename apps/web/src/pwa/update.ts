// PURE. Contract §8.5.

export interface UpdateState {
  waiting: boolean
  applying: boolean
  deferred: boolean
}

export type UpdateEvent =
  | { kind: 'workerWaiting' }
  | { kind: 'raceStarted' }
  | { kind: 'raceEnded' }
  | { kind: 'userAccepted' }
  | { kind: 'userDismissed' }

export function createUpdateState(): UpdateState {
  return { waiting: false, applying: false, deferred: false }
}

/** Illegal/no-op transitions preserve object identity for cheap rendering. */
export function reduceUpdate(prev: UpdateState, ev: UpdateEvent): UpdateState {
  if (prev.applying) return prev

  switch (ev.kind) {
    case 'workerWaiting':
      return prev.waiting ? prev : { ...prev, waiting: true }
    case 'raceStarted':
      return prev.deferred ? prev : { ...prev, deferred: true }
    case 'raceEnded':
      return prev.deferred ? { ...prev, deferred: false } : prev
    case 'userAccepted':
      if (!prev.waiting || prev.deferred) return prev
      return { waiting: false, applying: true, deferred: false }
    case 'userDismissed':
      if (!prev.waiting || prev.deferred) return prev
      return { ...prev, deferred: true }
  }
}
