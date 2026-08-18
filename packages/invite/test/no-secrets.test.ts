import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The repository root: this file is at <root>/packages/invite/test/. */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** A floor on the number of files actually scanned. */
const MIN_SCANNED_FILES = 20

/** A PEM block header. The trailing dashes are required. */
const PEM_HEADER = /-----BEGIN [A-Z0-9 ]+-----/

/** A complete dotted quad inside the three RFC 1918 ranges, excluding CIDRs. */
const RFC1918 =
  /(^|[^0-9.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![0-9./])/

/** 32 colon-separated hex byte pairs: a SHA-256 certificate fingerprint. */
const COLON_HEX_32 = /(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}/g

/** Contract §1 permits exactly this one obvious placeholder. */
const ALLOWED_FINGERPRINT =
  'DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF'

function isObviouslyFakeFingerprint(hit: string): boolean {
  return hit === ALLOWED_FINGERPRINT
}

const KEYSTORE_EXTENSIONS = ['.jks', '.keystore', '.p12']

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter((p) => p.length > 0)
}

function isBinary(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8192)
  return head.includes(0)
}

describe('contract §1: nothing secret, real or private is in this repository', () => {
  it('can enumerate the repository, or fails', () => {
    let files: string[] = []
    expect(() => {
      files = trackedFiles()
    }).not.toThrow()
    expect(files.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES)
  })

  it('tracks no keystore, in any of its three spellings', () => {
    const offenders = trackedFiles().filter((p) =>
      KEYSTORE_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext)),
    )
    expect(offenders).toEqual([])
  })

  it('carries no PEM block, no RFC1918 address, and no fingerprint but the placeholder', () => {
    const files = trackedFiles()
    const problems: string[] = []
    let scanned = 0

    for (const rel of files) {
      let bytes: Buffer
      try {
        bytes = readFileSync(new URL(rel, new URL(REPO_ROOT, 'file:')))
      } catch {
        continue
      }
      if (isBinary(bytes)) continue
      scanned++

      const lines = bytes.toString('utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (PEM_HEADER.test(line)) problems.push(`${rel}:${i + 1}: a PEM block header`)
        const lan = RFC1918.exec(line)
        if (lan !== null) problems.push(`${rel}:${i + 1}: an RFC1918 address (${lan[2]})`)
        const hits = line.match(COLON_HEX_32)
        if (hits !== null) {
          for (const hit of hits) {
            if (!isObviouslyFakeFingerprint(hit)) {
              problems.push(
                `${rel}:${i + 1}: a certificate fingerprint that is not §1's placeholder`,
              )
            }
          }
        }
      }
    }

    expect(scanned).toBeGreaterThanOrEqual(MIN_SCANNED_FILES)
    expect(problems).toEqual([])
  })
})
