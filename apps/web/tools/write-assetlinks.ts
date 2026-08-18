// Container entrypoint tool. Runs once, before the server, inside the image.
// It uses the shipped App Links builder and validator rather than duplicating them.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ASSETLINKS_PATH,
  buildAssetLinks,
  parseFingerprintList,
  validateAssetLinks,
} from '@tapkart/invite'

/** The App Links path below the same static root the server serves. */
export function assetLinksTargetPath(staticRoot: string): string {
  const root = staticRoot.replace(/\/+$/, '')
  return `${root}${ASSETLINKS_PATH}`
}

/** Builds, validates, and writes assetlinks.json from the container environment. */
export function writeAssetLinks(env: Record<string, string | undefined>): string[] {
  const packageName = (env.TAPKART_ANDROID_PACKAGE ?? '').trim()
  const rawFingerprints = (env.TAPKART_SHA256_FINGERPRINTS ?? '').trim()
  const staticRoot = (env.STATIC_ROOT ?? '').trim()
  const target = staticRoot === '' ? null : assetLinksTargetPath(staticRoot)

  // A container can restart in the same writable layer after its App Links
  // variables are removed or corrected. The generated file belongs to this
  // tool, so clear the prior run before deciding whether this run may replace
  // it. Otherwise the advertised "no APK" mode can keep serving stale signing
  // metadata indefinitely.
  if (target !== null) rmSync(target, { force: true })

  if (packageName === '' && rawFingerprints === '') {
    console.log(
      'write-assetlinks: TAPKART_ANDROID_PACKAGE and TAPKART_SHA256_FINGERPRINTS are unset; ' +
        'no assetlinks.json written. Android App Links will not verify for this deployment, ' +
        'which is correct if you are not shipping an APK.',
    )
    return []
  }

  if (target === null) {
    throw new Error(
      'write-assetlinks: STATIC_ROOT is unset. It has no default here on purpose: the ' +
        "schema default is the relative 'apps/web/dist', which is a checkout path and wrong " +
        'inside the image.',
    )
  }

  const problems: string[] = []
  if (packageName === '') {
    problems.push('TAPKART_ANDROID_PACKAGE is empty but TAPKART_SHA256_FINGERPRINTS is set')
  }
  if (rawFingerprints === '') {
    problems.push('TAPKART_SHA256_FINGERPRINTS is empty but TAPKART_ANDROID_PACKAGE is set')
  }
  if (problems.length > 0) return problems

  let fingerprints: string[]
  try {
    fingerprints = parseFingerprintList(rawFingerprints)
  } catch (error) {
    return [(error as Error).message]
  }

  let statement: unknown
  try {
    statement = buildAssetLinks(packageName, fingerprints)
  } catch (error) {
    return [`buildAssetLinks: ${(error as Error).message}`]
  }

  const invalid = validateAssetLinks(statement)
  if (invalid.length > 0) return invalid

  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(statement, null, 2)}\n`, 'utf8')
  console.log(
    `write-assetlinks: wrote ${target} for ${packageName} (${fingerprints.length} fingerprint(s))`,
  )
  return []
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = writeAssetLinks(process.env)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`write-assetlinks: ${problem}`)
    process.exitCode = 1
  }
}
