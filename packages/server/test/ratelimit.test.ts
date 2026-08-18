import { describe, expect, it } from 'vitest'
import { makeRateLimiter } from '../src/ratelimit'

describe('makeRateLimiter', () => {
  it('allows until the budget is spent, and `allowed` never consumes', () => {
    const rl = makeRateLimiter({ windowMs: 1000, max: 3 })
    for (let i = 0; i < 100; i++) expect(rl.allowed('ABCDE', 0)).toBe(true)
    rl.note('ABCDE', 0)
    rl.note('ABCDE', 0)
    expect(rl.allowed('ABCDE', 0)).toBe(true)
    rl.note('ABCDE', 0)
    expect(rl.allowed('ABCDE', 0)).toBe(false)
    for (let i = 0; i < 10; i++) expect(rl.allowed('ABCDE', 0)).toBe(false)
  })

  it('has an exact window boundary', () => {
    const rl = makeRateLimiter({ windowMs: 1000, max: 1 })
    rl.note('ABCDE', 0)
    expect(rl.allowed('ABCDE', 999)).toBe(false)
    expect(rl.allowed('ABCDE', 1000)).toBe(true)
    rl.note('ABCDE', 1000)
    expect(rl.allowed('ABCDE', 1999)).toBe(false)
    expect(rl.allowed('ABCDE', 2000)).toBe(true)
  })

  it('keys are independent', () => {
    const rl = makeRateLimiter({ windowMs: 1000, max: 1 })
    rl.note('ABCDE', 0)
    expect(rl.allowed('ABCDE', 0)).toBe(false)
    expect(rl.allowed('FGHJK', 0)).toBe(true)
  })

  it('reset clears everything', () => {
    const rl = makeRateLimiter({ windowMs: 1000, max: 1 })
    rl.note('ABCDE', 0)
    expect(rl.allowed('ABCDE', 0)).toBe(false)
    rl.reset()
    expect(rl.allowed('ABCDE', 0)).toBe(true)
  })

  it('bounds its own key space under a flood of distinct keys', () => {
    const rl = makeRateLimiter({ windowMs: 1000, max: 1 })
    for (let i = 0; i < 20_000; i++) rl.note('K' + String(i), 0)
    rl.note('ZZZZZ', 0)
    expect(rl.allowed('ZZZZZ', 0)).toBe(false)
    expect(rl.allowed('YYYYY', 0)).toBe(true)
  })
})
