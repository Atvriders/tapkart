import { describe, expect, it } from 'vitest'
import { createUpdateState, reduceUpdate, type UpdateEvent, type UpdateState } from '../src/pwa/update'

const ALL_EVENTS: UpdateEvent[] = [
  { kind: 'workerWaiting' },
  { kind: 'raceStarted' },
  { kind: 'raceEnded' },
  { kind: 'userAccepted' },
  { kind: 'userDismissed' },
]

describe('createUpdateState', () => {
  it('starts with nothing waiting, applying, or deferred', () => {
    expect(createUpdateState()).toEqual({ waiting: false, applying: false, deferred: false })
  })

  it('returns a fresh object each time', () => {
    expect(createUpdateState()).not.toBe(createUpdateState())
  })
})

describe('reduceUpdate', () => {
  it('never mutates prev', () => {
    for (const ev of ALL_EVENTS) {
      const prev: UpdateState = { waiting: true, applying: false, deferred: false }
      const snapshot = { ...prev }
      reduceUpdate(prev, ev)
      expect(prev).toEqual(snapshot)
    }
  })

  it('workerWaiting marks a worker waiting', () => {
    expect(reduceUpdate(createUpdateState(), { kind: 'workerWaiting' })).toEqual({
      waiting: true,
      applying: false,
      deferred: false,
    })
  })

  it('acceptance applies only a waiting, non-deferred worker', () => {
    const waiting: UpdateState = { waiting: true, applying: false, deferred: false }
    expect(reduceUpdate(waiting, { kind: 'userAccepted' })).toEqual({
      waiting: false,
      applying: true,
      deferred: false,
    })
  })

  it('userAccepted with no worker waiting is a no-op', () => {
    const idle = createUpdateState()
    expect(reduceUpdate(idle, { kind: 'userAccepted' })).toBe(idle)
  })

  it('userAccepted during a race is a no-op', () => {
    const racing: UpdateState = { waiting: true, applying: false, deferred: true }
    expect(reduceUpdate(racing, { kind: 'userAccepted' })).toBe(racing)
  })

  it('raceStarted defers, and raceEnded un-defers', () => {
    const waiting: UpdateState = { waiting: true, applying: false, deferred: false }
    const racing = reduceUpdate(waiting, { kind: 'raceStarted' })
    expect(racing).toEqual({ waiting: true, applying: false, deferred: true })
    expect(reduceUpdate(racing, { kind: 'raceEnded' })).toEqual({
      waiting: true,
      applying: false,
      deferred: false,
    })
  })

  it('remembers a worker that arrives mid-race and can apply it after the race', () => {
    let state = createUpdateState()
    state = reduceUpdate(state, { kind: 'raceStarted' })
    state = reduceUpdate(state, { kind: 'workerWaiting' })
    expect(state).toEqual({ waiting: true, applying: false, deferred: true })
    state = reduceUpdate(state, { kind: 'userAccepted' })
    expect(state.applying).toBe(false)
    state = reduceUpdate(state, { kind: 'raceEnded' })
    state = reduceUpdate(state, { kind: 'userAccepted' })
    expect(state).toEqual({ waiting: false, applying: true, deferred: false })
  })

  it('userDismissed keeps the worker waiting but stops it being offered', () => {
    const waiting: UpdateState = { waiting: true, applying: false, deferred: false }
    expect(reduceUpdate(waiting, { kind: 'userDismissed' })).toEqual({
      waiting: true,
      applying: false,
      deferred: true,
    })
  })

  it('a dismissed update is offered again after the next race ends', () => {
    let state: UpdateState = { waiting: true, applying: false, deferred: false }
    state = reduceUpdate(state, { kind: 'userDismissed' })
    expect(state.deferred).toBe(true)
    state = reduceUpdate(state, { kind: 'raceEnded' })
    expect(state.deferred).toBe(false)
  })

  it('once applying, no event un-applies it', () => {
    const applying: UpdateState = { waiting: false, applying: true, deferred: false }
    for (const ev of ALL_EVENTS) expect(reduceUpdate(applying, ev).applying).toBe(true)
  })

  it('returns prev by reference for every no-op', () => {
    const idle = createUpdateState()
    expect(reduceUpdate(idle, { kind: 'userAccepted' })).toBe(idle)
    expect(reduceUpdate(idle, { kind: 'userDismissed' })).toBe(idle)
    expect(reduceUpdate(idle, { kind: 'raceEnded' })).toBe(idle)
  })
})
