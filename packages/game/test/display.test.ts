import { describe, expect, it } from 'vitest'

import type { FullscreenGate } from '../src/display'
import { createFullscreenGate, nullDisplayHost, reduceFullscreen } from '../src/display'

/** Fold a sequence of events, returning every `ask` decision along the way. */
function run(events: Parameters<typeof reduceFullscreen>[1][]): { asks: boolean[]; gate: FullscreenGate } {
  let gate = createFullscreenGate()
  const asks: boolean[] = []
  for (const ev of events) {
    const next = reduceFullscreen(gate, ev)
    gate = next.gate
    asks.push(next.ask)
  }
  return { asks, gate }
}

describe('the fullscreen gate asks once, then respects the answer', () => {
  it('asks on the first gesture and not on the second', () => {
    // Asking twice is not harmless: a second request from a gesture the browser
    // has already answered is what triggers throttling.
    expect(run([{ kind: 'gesture' }, { kind: 'gesture' }]).asks).toEqual([true, false])
  })

  it('stops asking once fullscreen was entered', () => {
    const { asks } = run([{ kind: 'gesture' }, { kind: 'entered' }, { kind: 'gesture' }])
    expect(asks).toEqual([true, false, false])
  })

  it('never asks again unprompted after a deliberate exit', () => {
    // The case this whole module exists for. Someone who swipes out of fullscreen
    // and is dragged back in on their next tap cannot win, and will not try again.
    const { asks, gate } = run([
      { kind: 'gesture' }, { kind: 'entered' }, { kind: 'left' },
      { kind: 'gesture' }, { kind: 'gesture' },
    ])
    expect(asks).toEqual([true, false, false, false, false])
    expect(gate.userExited).toBe(true)
  })

  it('lets the explicit toggle back in, and clears the exit flag', () => {
    const { asks, gate } = run([
      { kind: 'gesture' }, { kind: 'entered' }, { kind: 'left' }, { kind: 'explicitRequest' },
    ])
    expect(asks[3]).toBe(true)
    expect(gate.userExited).toBe(false)
    // ...and having asked explicitly, a later incidental gesture still does not.
    expect(reduceFullscreen(gate, { kind: 'gesture' }).ask).toBe(false)
  })

  it('asks on an explicit request even from a fresh gate', () => {
    expect(reduceFullscreen(createFullscreenGate(), { kind: 'explicitRequest' }).ask).toBe(true)
  })

  it('never mutates the gate it was given', () => {
    const gate = createFullscreenGate()
    const frozen = { ...gate }
    reduceFullscreen(gate, { kind: 'gesture' })
    reduceFullscreen(gate, { kind: 'left' })
    expect(gate).toEqual(frozen)
  })
})

describe('nullDisplayHost is a working configuration, not an error', () => {
  it('reports no support and resolves without throwing', async () => {
    expect(nullDisplayHost.supported()).toBe(false)
    expect(nullDisplayHost.isFullscreen()).toBe(false)
    await expect(nullDisplayHost.request()).resolves.toBeUndefined()
    expect(() => nullDisplayHost.onChange(() => {})()).not.toThrow()
  })
})
