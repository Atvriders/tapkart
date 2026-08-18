import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', 'src')

const FORBIDDEN = ['cf-connecting-ip', 'x-forwarded-for', 'remoteaddress', 'socket.address']

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('no IP-derived rate-limit keys', () => {
  it('names no address header or socket address anywhere in packages/server/src', () => {
    const files = sources(SRC)
    // The floor: a broken walker would pass this test with zero files read.
    expect(files.length).toBeGreaterThan(0)

    const hits: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8').toLowerCase()
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) hits.push(file + ' contains ' + needle)
      }
    }
    // Behind a Cloudflare Tunnel every request is one TCP peer. This project has
    // already collapsed to 60 accounts per building per 15 minutes that way.
    // F-P4-34 keys the limiter on the ROOM CODE, and this makes it mechanical.
    expect(hits).toEqual([])
  })
})
