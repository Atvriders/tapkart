import { describe, expect, it } from 'vitest'
import { CHARACTERS, TRACK_MANIFEST, TUNING, loadTrack } from '@tapkart/content'
import { defaultContentProvider, makeContentProvider } from '../src/content'

describe('ContentProvider.trackIds / track', () => {
  it('is exactly the shipped manifest, in menu order', () => {
    const provider = makeContentProvider()
    expect(provider.trackIds()).toEqual(TRACK_MANIFEST.map((entry) => entry.id))
    expect(provider.trackIds().length).toBeGreaterThan(0)
  })

  it('returns a real Track for every manifest id and null for anything else', () => {
    const provider = makeContentProvider()
    for (const entry of TRACK_MANIFEST) {
      const track = provider.track(entry.id)
      expect(track).not.toBeNull()
      expect(track?.id).toBe(entry.id)
      expect(track?.startPositions.length).toBeGreaterThan(0)
    }
    expect(provider.track('not-a-track')).toBeNull()
    expect(provider.track('')).toBeNull()
  })
})

describe('ContentProvider.contextFor', () => {
  const first = TRACK_MANIFEST[0].id

  it('returns a DISTINCT object every call, with isLeader false', () => {
    const provider = makeContentProvider()
    const a = provider.contextFor(first)
    const b = provider.contextFor(first)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
    expect(a?.isLeader).toBe(false)
    expect(b?.isLeader).toBe(false)
  })

  it('does not let one context promotion reach another', () => {
    const provider = makeContentProvider()
    const a = provider.contextFor(first)!
    const b = provider.contextFor(first)!
    a.isLeader = true
    expect(b.isLeader).toBe(false)
    expect(provider.contextFor(first)?.isLeader).toBe(false)
  })

  it('shares the track and query inside it', () => {
    const provider = makeContentProvider()
    const a = provider.contextFor(first)!
    const b = provider.contextFor(first)!
    expect(a.track).toBe(b.track)
    expect(a.query).toBe(b.query)
    expect(a.track).toBe(loadTrack(first).track)
  })

  it('carries the shipped tuning and characters', () => {
    const ctx = makeContentProvider().contextFor(first)!
    expect(ctx.tuning.maxSpeed).toBe(TUNING.maxSpeed)
    expect(ctx.characters).toHaveLength(CHARACTERS.length)
    expect(ctx.characters[0].id).toBe(CHARACTERS[0].id)
    expect(ctx.characters).not.toBe(CHARACTERS as unknown as typeof ctx.characters)
  })

  it('returns null for an unknown track', () => {
    expect(makeContentProvider().contextFor('not-a-track')).toBeNull()
  })
})

describe('defaultContentProvider', () => {
  it('is a ContentProvider over the same shipped data', () => {
    expect(defaultContentProvider.trackIds()).toEqual(TRACK_MANIFEST.map((entry) => entry.id))
    const ctx = defaultContentProvider.contextFor(TRACK_MANIFEST[0].id)
    expect(ctx).not.toBeNull()
    expect(ctx?.isLeader).toBe(false)
    expect(defaultContentProvider.contextFor(TRACK_MANIFEST[0].id)).not.toBe(ctx)
  })
})
