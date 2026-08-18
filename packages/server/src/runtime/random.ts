// ADAPTER. The only node:crypto in packages/server.
import { randomBytes } from 'node:crypto'
import type { RandomSource } from '../random'

export const nodeRandomSource: RandomSource = (bytes: number): Uint8Array =>
  new Uint8Array(randomBytes(bytes))
