// PURE. Browser and server consume the same statically authored tracks.
import { CHARACTERS, TRACK_MANIFEST, TUNING, loadTrack } from '@tapkart/content'
import type { SimContext, Track } from '@tapkart/sim'

export interface ContentProvider {
  track(id: string): Track | null
  contextFor(trackId: string): SimContext | null
  trackIds(): readonly string[]
}

export function makeContentProvider(): ContentProvider {
  const ids: readonly string[] = TRACK_MANIFEST.map((entry) => entry.id)
  const known = new Set(ids)

  return {
    track(id: string): Track | null {
      return known.has(id) ? loadTrack(id).track : null
    },

    contextFor(trackId: string): SimContext | null {
      if (!known.has(trackId)) return null
      const loaded = loadTrack(trackId)
      return {
        track: loaded.track,
        query: loaded.query,
        tuning: TUNING,
        characters: CHARACTERS.slice(),
        isLeader: false,
      }
    },

    trackIds(): readonly string[] {
      return ids
    },
  }
}

export const defaultContentProvider: ContentProvider = makeContentProvider()
