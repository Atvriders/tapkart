// ADAPTER. The only node:fs in packages/server/src. It reads static bytes for
// the HTTP handler; shipped game content is statically imported instead.
import { readFileSync, statSync } from 'node:fs'

/** null for anything unreadable -- absent, a directory, or denied. */
export function readFileBytes(path: string): Uint8Array | null {
  try {
    const buf = readFileSync(path)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } catch {
    return null
  }
}

export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
