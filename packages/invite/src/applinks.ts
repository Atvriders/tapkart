// packages/invite/src/applinks.ts                                       PURE
//
// The Digital Asset Links statement that makes an https:// invite URI open the
// app instead of a browser. Contract §4.7.
//
// This module builds and validates the document. It does NOT write it (§11.3's
// generator does, at container start) and it does NOT serve it (Plan 4's static
// handler does, with no redirect — ruling C-2). It touches no filesystem, no
// environment and no network.

/** The only relation an App Link needs, spelled the way Google's verifier reads it. */
export const APP_LINKS_RELATION = 'delegate_permission/common.handle_all_urls'

/** Where the statement is served. Plan 4 treats /.well-known/* as a real route
 *  with no trailing-slash normalisation and no redirect (C-2); a 3xx here is
 *  spec §2's silent App Links failure. */
export const ASSETLINKS_PATH = '/.well-known/assetlinks.json'

/** 32 uppercase hex byte pairs, colon separated: 95 characters exactly.
 *
 *  No `g` and no `y` flag, ever: `RegExp.prototype.test` advances `lastIndex` on
 *  a global or sticky regex, so a shared instance would answer `false` to every
 *  second call and the second fingerprint in a two-certificate list would be
 *  rejected for no visible reason. */
export const FINGERPRINT_PATTERN = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/

export interface AssetLinksTarget {
  namespace: 'android_app'
  package_name: string
  sha256_cert_fingerprints: string[]
}

export interface AssetLinksStatement {
  relation: string[]
  target: AssetLinksTarget
}

/** Strict about case and separator, deliberately: a repo that permits two
 *  spellings acquires two spellings, and then §12.2's assertion 28 — comparing
 *  `apksigner verify --print-certs` output to the repo variable — starts failing
 *  for a reason nobody can see. */
export function isValidFingerprint(s: string): boolean {
  return FINGERPRINT_PATTERN.test(s)
}

/** Splits on commas and whitespace, trims, upper-cases, drops empties.
 *  Throws naming the offending entry if any survivor fails validation.
 *
 *  Upper-casing on the way in is what lets the owner paste either spelling out
 *  of `keytool` or `apksigner` without thinking about it. */
export function parseFingerprintList(raw: string): string[] {
  const parts = raw
    .split(/[\s,]+/)
    .map((p) => p.trim().toUpperCase())
    .filter((p) => p.length > 0)
  for (const p of parts) {
    if (!isValidFingerprint(p)) {
      throw new Error(
        `TAPKART_SHA256_FINGERPRINTS: not a SHA-256 certificate fingerprint: ${p} ` +
          '(expected 32 uppercase hex bytes separated by colons, 95 characters)',
      )
    }
  }
  return parts
}

/** One statement, one target, N fingerprints. Throws on an empty list — and on
 *  nothing else. A malformed fingerprint is `validateAssetLinks`' to report,
 *  because §11.3's generator must be able to LOG the problems and exit 1 rather
 *  than die on a stack trace. */
export function buildAssetLinks(
  packageName: string,
  fingerprints: readonly string[],
): AssetLinksStatement[] {
  if (fingerprints.length === 0) {
    throw new Error('buildAssetLinks: at least one SHA-256 certificate fingerprint is required')
  }
  return [
    {
      relation: [APP_LINKS_RELATION],
      target: {
        namespace: 'android_app',
        package_name: packageName,
        sha256_cert_fingerprints: [...fingerprints],
      },
    },
  ]
}

/** Structural validation of parsed JSON from anywhere — a file, a fetch, a
 *  container. Returns a list of human-readable problems; `[]` means valid.
 *  Every problem names the field and, where there is more than one, the index. */
export function validateAssetLinks(json: unknown): string[] {
  if (!Array.isArray(json)) {
    return ['assetlinks.json: the document must be an array of statements']
  }
  if (json.length === 0) {
    return ['assetlinks.json: the document must contain at least one statement']
  }

  const problems: string[] = []
  for (let i = 0; i < json.length; i++) {
    const where = `statement[${i}]`
    const entry: unknown = json[i]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`${where}: must be an object`)
      continue
    }
    const statement = entry as Record<string, unknown>

    const relation: unknown = statement['relation']
    if (!Array.isArray(relation) || relation.length === 0) {
      problems.push(`${where}.relation: must be a non-empty array of strings`)
    } else if (!relation.every((r: unknown) => typeof r === 'string')) {
      problems.push(`${where}.relation: every entry must be a string`)
    } else if (!relation.includes(APP_LINKS_RELATION)) {
      problems.push(`${where}.relation: must include ${APP_LINKS_RELATION}`)
    }

    const target: unknown = statement['target']
    if (typeof target !== 'object' || target === null || Array.isArray(target)) {
      problems.push(`${where}.target: must be an object`)
      continue
    }
    const t = target as Record<string, unknown>

    if (t['namespace'] !== 'android_app') {
      problems.push(`${where}.target.namespace: must be "android_app"`)
    }

    const packageName: unknown = t['package_name']
    if (typeof packageName !== 'string' || packageName.length === 0) {
      problems.push(`${where}.target.package_name: must be a non-empty string`)
    }

    const fingerprints: unknown = t['sha256_cert_fingerprints']
    if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
      problems.push(`${where}.target.sha256_cert_fingerprints: must be a non-empty array`)
    } else {
      for (let j = 0; j < fingerprints.length; j++) {
        const fp: unknown = fingerprints[j]
        if (typeof fp !== 'string' || !isValidFingerprint(fp)) {
          problems.push(
            `${where}.target.sha256_cert_fingerprints[${j}]: must be 32 uppercase hex bytes ` +
              'separated by colons',
          )
        }
      }
    }
  }
  return problems
}

/** The environment variables the assetlinks generator reads, and the ONLY
 *  variables in the deployment that `packages/server`'s ENV_SCHEMA does not
 *  own. §11.4's drift test asserts the Dockerfile, the compose file and the
 *  README name exactly `ENV_SCHEMA ∪ ASSETLINKS_ENV_VARS`.
 *
 *  `TAPKART_ORIGIN` is deliberately absent: ruling L2 made it a BUILD variable
 *  only (§3.1), and assetlinks.json contains no origin — it is served at one. */
export const ASSETLINKS_ENV_VARS = [
  'TAPKART_ANDROID_PACKAGE',
  'TAPKART_SHA256_FINGERPRINTS',
] as const satisfies readonly ['TAPKART_ANDROID_PACKAGE', 'TAPKART_SHA256_FINGERPRINTS']
