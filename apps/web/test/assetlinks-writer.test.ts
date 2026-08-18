import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAssetLinks, parseFingerprintList } from '@tapkart/invite'
import {
  assetLinksTargetPath,
  writeAssetLinks,
} from '../tools/write-assetlinks'

const PACKAGE = 'io.github.atvriders.tapkart'
const FINGERPRINT =
  'DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:' +
  'DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tapkart-assetlinks-'))
  roots.push(root)
  return root
}

function plant(root: string, body = 'stale\n'): string {
  const target = assetLinksTargetPath(root)
  mkdirSync(join(root, '.well-known'), { recursive: true })
  writeFileSync(target, body, 'utf8')
  return target
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('the container assetlinks writer', () => {
  it('writes the exact normalized statement below STATIC_ROOT', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const root = tempRoot()
    const problems = writeAssetLinks({
      STATIC_ROOT: root,
      TAPKART_ANDROID_PACKAGE: ` ${PACKAGE} `,
      TAPKART_SHA256_FINGERPRINTS: FINGERPRINT.toLowerCase(),
    })

    expect(problems).toEqual([])
    expect(JSON.parse(readFileSync(assetLinksTargetPath(root), 'utf8'))).toEqual(
      buildAssetLinks(PACKAGE, parseFingerprintList(FINGERPRINT)),
    )
  })

  it('removes a statement from a prior run when both App Links variables are now unset', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const root = tempRoot()
    const target = plant(root)

    expect(writeAssetLinks({ STATIC_ROOT: root })).toEqual([])
    expect(() => readFileSync(target)).toThrow()
  })

  it('removes stale output before rejecting a partially configured run', () => {
    const root = tempRoot()
    const target = plant(root)

    expect(writeAssetLinks({
      STATIC_ROOT: root,
      TAPKART_ANDROID_PACKAGE: PACKAGE,
    })).toEqual([
      'TAPKART_SHA256_FINGERPRINTS is empty but TAPKART_ANDROID_PACKAGE is set',
    ])
    expect(() => readFileSync(target)).toThrow()
  })

  it('still requires STATIC_ROOT whenever it has metadata to write', () => {
    expect(() => writeAssetLinks({
      TAPKART_ANDROID_PACKAGE: PACKAGE,
      TAPKART_SHA256_FINGERPRINTS: FINGERPRINT,
    })).toThrow(/STATIC_ROOT is unset/)
  })
})
