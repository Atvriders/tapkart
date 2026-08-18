import { describe, expect, it } from 'vitest'
import * as precacheModule from '../tools/precache.mjs'
import { buildPrecacheList, precacheVersion } from '../tools/precache.mjs'

const VITE_MANIFEST = {
  'index.html': {
    file: 'assets/index-1a2b3c4d.js',
    src: 'index.html',
    isEntry: true,
    css: ['assets/index-9f8e7d6c.css'],
    assets: ['assets/kart-5e4d3c2b.png'],
  },
  '_shared-aabbccdd.js': {
    file: 'assets/shared-aabbccdd.js',
    css: [],
  },
}

const EXTRAS = ['/index.html', '/manifest.webmanifest', '/icons/icon-192.png']

describe('precache tool surface', () => {
  it('exports exactly the two functions fixed by §16', () => {
    expect(Object.keys(precacheModule).sort()).toEqual(['buildPrecacheList', 'precacheVersion'])
  })
})

describe('buildPrecacheList', () => {
  it('takes every file, css, and asset as absolute paths', () => {
    expect(buildPrecacheList(VITE_MANIFEST, [])).toEqual([
      '/assets/index-1a2b3c4d.js',
      '/assets/index-9f8e7d6c.css',
      '/assets/kart-5e4d3c2b.png',
      '/assets/shared-aabbccdd.js',
    ])
  })

  it('merges extras and sorts the whole list', () => {
    expect(buildPrecacheList(VITE_MANIFEST, EXTRAS)).toEqual([
      '/assets/index-1a2b3c4d.js',
      '/assets/index-9f8e7d6c.css',
      '/assets/kart-5e4d3c2b.png',
      '/assets/shared-aabbccdd.js',
      '/icons/icon-192.png',
      '/index.html',
      '/manifest.webmanifest',
    ])
  })

  it('de-duplicates shared chunks and extras', () => {
    const duplicate = {
      a: { file: 'assets/shared.js', css: ['assets/one.css'] },
      b: { file: 'assets/shared.js', css: ['assets/one.css'] },
    }
    expect(buildPrecacheList(duplicate, ['/assets/shared.js'])).toEqual([
      '/assets/one.css',
      '/assets/shared.js',
    ])
  })

  it('is stable when Vite reorders its manifest', () => {
    const reversed = Object.fromEntries(Object.entries(VITE_MANIFEST).reverse())
    expect(buildPrecacheList(reversed, EXTRAS)).toEqual(buildPrecacheList(VITE_MANIFEST, EXTRAS))
  })

  it('does not double an existing leading slash', () => {
    expect(buildPrecacheList({}, ['/index.html'])).toEqual(['/index.html'])
  })

  it('returns an empty list for no manifest records or extras', () => {
    expect(buildPrecacheList({}, [])).toEqual([])
  })

  it('throws on a manifest record with no file', () => {
    expect(() => buildPrecacheList({ bad: { css: [] } }, [])).toThrow(
      "buildPrecacheList: manifest entry 'bad' has no 'file'",
    )
  })
})

describe('precacheVersion', () => {
  it('is stable for the same list', () => {
    const list = buildPrecacheList(VITE_MANIFEST, EXTRAS)
    expect(precacheVersion(list)).toBe(precacheVersion([...list]))
  })

  it('changes when a content-hashed path changes', () => {
    const list = buildPrecacheList(VITE_MANIFEST, EXTRAS)
    const moved = list.map((path) =>
      path.includes('index-1a2b3c4d') ? '/assets/index-deadbeef.js' : path,
    )
    expect(precacheVersion(moved)).not.toBe(precacheVersion(list))
  })

  it('changes when an entry is added', () => {
    expect(precacheVersion(['/a.js'])).not.toBe(precacheVersion(['/a.js', '/b.js']))
  })

  it('is short lowercase hex safe inside a Cache name', () => {
    expect(precacheVersion(['/a.js'])).toMatch(/^[0-9a-f]{8}$/)
  })

  it('distinguishes lists whose entries concatenate to the same characters', () => {
    expect(precacheVersion(['/ab.js', '/c.js'])).not.toBe(precacheVersion(['/a.js', '/bc.js']))
  })

  it('accepts private content-digest seeds without changing the fetch list', () => {
    const fetchList = ['/index.html', '/manifest.webmanifest']
    const before = [...fetchList]
    const first = fetchList.map((path) => `${path}\0sha256:aaaa`)
    const changed = fetchList.map((path) => `${path}\0sha256:${path === '/index.html' ? 'bbbb' : 'aaaa'}`)
    expect(precacheVersion(first)).not.toBe(precacheVersion(changed))
    expect(fetchList).toEqual(before)
  })
})
