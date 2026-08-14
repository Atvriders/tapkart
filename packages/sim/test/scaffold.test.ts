import { describe, expect, it } from 'vitest'
import * as sim from '../src/index'

describe('workspace scaffold', () => {
  it('runs a TypeScript test from the repo root', () => {
    // TICK_HZ is 60 in the contract; 60 ticks * 3 seconds of countdown = 180,
    // which is COUNTDOWN_TICKS. Plain arithmetic here — the real constants
    // arrive in Task 2. This test only proves the toolchain executes TS.
    const tickHz: number = 60
    expect(tickHz * 3).toBe(180)
  })

  it('resolves the @tapkart/sim entry point with extensionless imports', () => {
    // '../src/index' has no file extension. This asserts that
    // moduleResolution: "Bundler" plus vitest's resolver agree with the
    // contract's import-style convention.
    expect(typeof sim).toBe('object')
  })
})
