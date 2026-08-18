import { describe, expect, it } from 'vitest'
import { MAX_KARTS, createState } from '@tapkart/sim'
import { encodeCheckpoint, encodeHeader } from '@tapkart/protocol'
import { defaultContentProvider } from '../src/content'
import { CHECKPOINT_BUF_BYTES } from '../src/hub'

describe('the server checkpoint buffer', () => {
  it('fits the maximum checkpoint shape of every shipped track', () => {
    const ids = defaultContentProvider.trackIds()
    expect(ids).toHaveLength(6)
    let largest = 0

    for (const id of ids) {
      const ctx = defaultContentProvider.contextFor(id)
      expect(ctx, id).not.toBeNull()
      const state = createState(ctx!, 0x5eed, new Array<number>(MAX_KARTS).fill(0))
      const frame = new Uint8Array(CHECKPOINT_BUF_BYTES)
      const headerBytes = encodeHeader(frame, 'checkpoint')
      const bodyBytes = encodeCheckpoint(frame.subarray(headerBytes), state)
      const frameBytes = headerBytes + bodyBytes
      expect(frameBytes, id).toBeLessThanOrEqual(CHECKPOINT_BUF_BYTES)
      largest = Math.max(largest, frameBytes)
    }

    // The old six-box estimate was 5,288 bytes. Keeping this floor proves this
    // test really exercised the larger shipped shape, rather than a tiny fake.
    expect(largest).toBeGreaterThan(5_288)
  })
})
