import { describe, expect, it } from 'vitest'
import * as net from '../src/index'

describe('net workspace scaffold', () => {
  it('runs a TypeScript test from the new @tapkart/net workspace', () => {
    expect(2 + 2).toBe(4)
  })

  it('resolves the @tapkart/net entry point with extensionless imports', () => {
    expect(typeof net).toBe('object')
  })
})
