### Task 7: `packages/invite/src/applinks.ts` — the App Links statement, PURE

**Files:**
- Create: `packages/invite/src/applinks.ts`
- Modify: `packages/invite/src/index.ts` — one `export *` line
- Test: `packages/invite/test/applinks.test.ts`

This module is the whole of Plan 5's half of ruling **C-2**: *"Plan 5's `write-assetlinks.ts` produces the file from `TAPKART_SHA256_FINGERPRINTS` at container start; Plan 4's static handler serves `/.well-known/assetlinks.json` **with no redirect**… Plan 5 asserts the *content* is well-formed and the fingerprint parses."* Nothing here writes a file, reads an environment, or serves a request — the generator (§11.3, a later task) and Plan 4's handler do those. This task owns exactly two questions: **what does a correct statement look like**, and **is this thing I was handed a correct statement**.

That split is why this file is pure. The generator can be a nine-line adapter that reads two variables and writes bytes, because every decision it would otherwise make lives here and is unit-tested with no filesystem.

**Why the strictness is not fussiness.** §3, value 5: `sha256_cert_fingerprints[0]` must equal the SHA-256 of the certificate that signed the **installed** APK, and §12.2's assertion 28 compares `apksigner verify --print-certs` output against the repo variable. Spec §2: *"on Android 12+ a failed verification is silent — no disambiguation chooser, the link just opens in the browser."* So a fingerprint that is right except for its case produces: a valid-looking `assetlinks.json`, a green CI run, and a tap that quietly opens a browser forever. §4.7 states the rule and the reason:

> `isValidFingerprint` is deliberately strict about **case and separator**: Google's verifier accepts what it accepts, but a repo that permits two spellings acquires two spellings, and then the CI assertion comparing `apksigner`'s output to the repo variable starts failing for a reason nobody can see. Upper-case, colon separated, 95 characters. `parseFingerprintList` upper-cases on the way in, so the owner may paste either.

**What this task's tests do not prove**, stated here because §14 depends on the list being honest: they do not prove Android's verifier accepts the statement, that the deployed origin serves it, or that any certificate exists. §14 rows 2 and 3; §14.1 owner checklist items 1 and 2. This task proves the bytes are shaped right.

**Interfaces:**

- **Consumes:** nothing. This module imports no other module in the repository — not `@tapkart/protocol`, not a sibling in `packages/invite`. An App Links statement contains no path, no origin and no room code (it is served *at* an origin, and §3.1 deleted `TAPKART_ORIGIN` from the container entirely), so there is nothing for it to import and the absence is the design.

  The one value it must agree with lives outside the type system, in **contract §1**, and appears in this task only inside the test:

  ```
  SHA-256 cert fingerprint placeholder — the ONLY fingerprint that may appear in a repo file:
  DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF
  Android applicationId placeholder: io.github.atvriders.tapkart
  ```

  32 obviously-fake bytes, format-valid **so validators can be tested against it** — which is this task. Never write any other fingerprint, in any file, in any form.

- **Produces** — contract §4.7, exactly ten exports and not an eleventh (§16's census fixes `invite/applinks` at 10):

  ```ts
  export const APP_LINKS_RELATION = 'delegate_permission/common.handle_all_urls'
  export const ASSETLINKS_PATH = '/.well-known/assetlinks.json'
  /** 32 uppercase hex byte pairs, colon separated: 95 characters exactly. */
  export const FINGERPRINT_PATTERN: RegExp
  export interface AssetLinksTarget {
    namespace: 'android_app'
    package_name: string
    sha256_cert_fingerprints: string[]
  }
  export interface AssetLinksStatement {
    relation: string[]
    target: AssetLinksTarget
  }
  export function isValidFingerprint(s: string): boolean
  export function parseFingerprintList(raw: string): string[]
  export function buildAssetLinks(packageName: string, fingerprints: readonly string[]): AssetLinksStatement[]
  export function validateAssetLinks(json: unknown): string[]
  export const ASSETLINKS_ENV_VARS: readonly ['TAPKART_ANDROID_PACKAGE', 'TAPKART_SHA256_FINGERPRINTS']
  ```

  Counting the census: `APP_LINKS_RELATION`, `ASSETLINKS_PATH`, `FINGERPRINT_PATTERN`, `AssetLinksTarget`, `AssetLinksStatement`, `isValidFingerprint`, `parseFingerprintList`, `buildAssetLinks`, `validateAssetLinks`, `ASSETLINKS_ENV_VARS` — ten.

**Three behaviours this task pins, because a later task depends on each:**

1. **`buildAssetLinks` throws on an empty list and on nothing else.** §11.3 says the generator, given set-and-malformed variables, *"logs the problems from `validateAssetLinks`, exit 1"* — a **list of problems**, not a stack trace. If `buildAssetLinks` also threw on a malformed fingerprint there would be nothing left for `validateAssetLinks` to report and the generator's documented behaviour would be unreachable. So building is permissive and validating is strict, deliberately.
2. **`parseFingerprintList` throws, naming the offending entry.** It is the owner-input path (`TAPKART_SHA256_FINGERPRINTS`, pasted by hand), and "which of the three did I get wrong" is the only useful thing to say. The generator turns that message into its exit-1 output.
3. **`FINGERPRINT_PATTERN` carries no `g` and no `y` flag.** `RegExp.prototype.test` on a sticky or global regex advances `lastIndex`, so the *second* call with the same string returns `false`. A shared, exported, stateful regex is a defect that presents as "the second fingerprint in the list is always rejected" — and with two fingerprints in the list being exactly the supported case for a debug build (§6.5), it would ship. There is a test for it below.

---

- [ ] **Step 1: Write the failing test**

Create `packages/invite/test/applinks.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  APP_LINKS_RELATION,
  ASSETLINKS_ENV_VARS,
  ASSETLINKS_PATH,
  FINGERPRINT_PATTERN,
  buildAssetLinks,
  isValidFingerprint,
  parseFingerprintList,
  validateAssetLinks,
} from '../src/applinks'

/**
 * Contract §1: the ONLY certificate fingerprint that may appear in a repo file.
 * 32 obviously-fake bytes, format-valid so a validator can be tested against it.
 */
const PLACEHOLDER =
  'DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF'

/** Contract §1, and §3 value 4: it must equal the Gradle applicationId. */
const PACKAGE = 'io.github.atvriders.tapkart'

/** A second format-valid value for the multi-fingerprint case, assembled at
 * runtime so the repository still contains exactly one 95-character
 * fingerprint literal, as contract §1 requires. */
const PLACEHOLDER_BYTES = PLACEHOLDER.split(':')
const PLACEHOLDER_2 = [...PLACEHOLDER_BYTES.slice(2), ...PLACEHOLDER_BYTES.slice(0, 2)].join(':')

describe('applinks constants', () => {
  it('spells the relation exactly as Google requires', () => {
    expect(APP_LINKS_RELATION).toBe('delegate_permission/common.handle_all_urls')
  })

  it('spells the well-known path exactly, with no trailing slash', () => {
    expect(ASSETLINKS_PATH).toBe('/.well-known/assetlinks.json')
    expect(ASSETLINKS_PATH.endsWith('/')).toBe(false)
    expect(ASSETLINKS_PATH.startsWith('/.well-known/')).toBe(true)
  })

  it('names exactly the two container variables the generator reads, in order', () => {
    expect([...ASSETLINKS_ENV_VARS]).toEqual([
      'TAPKART_ANDROID_PACKAGE',
      'TAPKART_SHA256_FINGERPRINTS',
    ])
  })

  it('does not name TAPKART_ORIGIN, which ruling L2 removed from the container', () => {
    // §3.1: the intent filter and the APK's bundle take TAPKART_ORIGIN at BUILD
    // time; assetlinks.json contains no origin at all. A container variable here
    // would be a third mechanism and Plan 4's parseConfig would have to know it.
    expect([...ASSETLINKS_ENV_VARS]).not.toContain('TAPKART_ORIGIN')
  })
})

describe('FINGERPRINT_PATTERN', () => {
  it('is anchored at both ends', () => {
    expect(FINGERPRINT_PATTERN.source.startsWith('^')).toBe(true)
    expect(FINGERPRINT_PATTERN.source.endsWith('$')).toBe(true)
  })

  it('carries neither the g nor the y flag', () => {
    // RegExp.test on a global or sticky regex advances lastIndex, so the second
    // call with the same string returns false. An exported stateful regex would
    // present as "the second fingerprint in the list is always rejected".
    expect(FINGERPRINT_PATTERN.flags).not.toContain('g')
    expect(FINGERPRINT_PATTERN.flags).not.toContain('y')
  })

  it('gives the same answer every time it is asked', () => {
    expect(isValidFingerprint(PLACEHOLDER)).toBe(true)
    expect(isValidFingerprint(PLACEHOLDER)).toBe(true)
    expect(isValidFingerprint(PLACEHOLDER)).toBe(true)
  })
})

describe('isValidFingerprint', () => {
  it('accepts the contract §1 placeholder, which is 95 characters', () => {
    expect(PLACEHOLDER).toHaveLength(95)
    expect(isValidFingerprint(PLACEHOLDER)).toBe(true)
    expect(isValidFingerprint(PLACEHOLDER_2)).toBe(true)
  })

  // §12.2 assertion 7, spelled out row by row.
  const rejected: [string, string][] = [
    ['lowercase', PLACEHOLDER.toLowerCase()],
    ['mixed case', 'De:Ad:BE:EF' + PLACEHOLDER.slice(11)],
    ['31 bytes', PLACEHOLDER.slice(0, 92)],
    ['33 bytes', PLACEHOLDER + ':DE'],
    ['no separators', PLACEHOLDER.split(':').join('')],
    ['hyphen separators', PLACEHOLDER.split(':').join('-')],
    ['space separators', PLACEHOLDER.split(':').join(' ')],
    ['SHA-1 length (20 bytes)', PLACEHOLDER.split(':').slice(0, 20).join(':')],
    ['a non-hex character', 'DG' + PLACEHOLDER.slice(2)],
    ['leading whitespace', ` ${PLACEHOLDER}`],
    ['trailing whitespace', `${PLACEHOLDER} `],
    ['trailing colon', `${PLACEHOLDER}:`],
    ['empty', ''],
    ['one byte', 'DE'],
    ['a single hex digit per group', 'D:E:A:D'],
  ]

  for (const [name, value] of rejected) {
    it(`rejects ${name}`, () => {
      expect(isValidFingerprint(value)).toBe(false)
    })
  }
})

describe('parseFingerprintList', () => {
  it('splits on commas', () => {
    expect(parseFingerprintList(`${PLACEHOLDER},${PLACEHOLDER_2}`)).toEqual([
      PLACEHOLDER,
      PLACEHOLDER_2,
    ])
  })

  it('splits on whitespace, including newlines', () => {
    expect(parseFingerprintList(`${PLACEHOLDER}\n${PLACEHOLDER_2}`)).toEqual([
      PLACEHOLDER,
      PLACEHOLDER_2,
    ])
    expect(parseFingerprintList(`  ${PLACEHOLDER}\t${PLACEHOLDER_2}  `)).toEqual([
      PLACEHOLDER,
      PLACEHOLDER_2,
    ])
  })

  it('drops empty entries from sloppy separators', () => {
    expect(parseFingerprintList(`,, ${PLACEHOLDER} ,,, ${PLACEHOLDER_2},`)).toEqual([
      PLACEHOLDER,
      PLACEHOLDER_2,
    ])
  })

  it('upper-cases on the way in, so the owner may paste either spelling', () => {
    expect(parseFingerprintList(PLACEHOLDER.toLowerCase())).toEqual([PLACEHOLDER])
  })

  it('returns an empty list for an empty or blank input', () => {
    expect(parseFingerprintList('')).toEqual([])
    expect(parseFingerprintList('   \n  ')).toEqual([])
  })

  it('throws naming the offending entry', () => {
    expect(() => parseFingerprintList(`${PLACEHOLDER},DE:AD:BE:EF`)).toThrow(/DE:AD:BE:EF/)
  })

  it('names the offending entry even when it is not the first', () => {
    let message = ''
    try {
      parseFingerprintList(`${PLACEHOLDER} ${PLACEHOLDER_2} NOT-A-FINGERPRINT`)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('NOT-A-FINGERPRINT')
  })
})

describe('buildAssetLinks', () => {
  it('builds one statement with one target', () => {
    const statements = buildAssetLinks(PACKAGE, [PLACEHOLDER])
    expect(statements).toHaveLength(1)
    expect(statements[0].relation).toEqual([APP_LINKS_RELATION])
    expect(statements[0].target.namespace).toBe('android_app')
    expect(statements[0].target.package_name).toBe(PACKAGE)
    expect(statements[0].target.sha256_cert_fingerprints).toEqual([PLACEHOLDER])
  })

  it('carries N fingerprints in order — §6.5 supports a debug certificate beside the release one', () => {
    const statements = buildAssetLinks(PACKAGE, [PLACEHOLDER, PLACEHOLDER_2])
    expect(statements[0].target.sha256_cert_fingerprints).toEqual([PLACEHOLDER, PLACEHOLDER_2])
  })

  it('copies the fingerprint list rather than aliasing the caller’s array', () => {
    const input = [PLACEHOLDER]
    const statements = buildAssetLinks(PACKAGE, input)
    input.push(PLACEHOLDER_2)
    expect(statements[0].target.sha256_cert_fingerprints).toEqual([PLACEHOLDER])
  })

  it('throws on an empty list', () => {
    expect(() => buildAssetLinks(PACKAGE, [])).toThrow()
  })

  it('does NOT throw on a malformed fingerprint — that is validateAssetLinks’ job', () => {
    // §11.3: the generator, given set-and-malformed variables, "logs the problems
    // from validateAssetLinks, exit 1". If building threw there would be no
    // problem list to log.
    const statements = buildAssetLinks(PACKAGE, ['nope'])
    expect(statements[0].target.sha256_cert_fingerprints).toEqual(['nope'])
    expect(validateAssetLinks(statements).length).toBeGreaterThan(0)
  })
})

describe('validateAssetLinks', () => {
  const good = () => buildAssetLinks(PACKAGE, [PLACEHOLDER])

  it('accepts what buildAssetLinks produced', () => {
    expect(validateAssetLinks(good())).toEqual([])
  })

  it('accepts it after a JSON round trip — which is what the container serves', () => {
    const overTheWire: unknown = JSON.parse(JSON.stringify(good()))
    expect(validateAssetLinks(overTheWire)).toEqual([])
  })

  // §12.2 assertion 8: names the field for each of these five.
  it('names the field for a wrong relation', () => {
    const bad = good()
    bad[0].relation = ['delegate_permission/common.get_login_creds']
    const problems = validateAssetLinks(bad)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('relation')
  })

  it('names the field for a wrong namespace', () => {
    const bad = JSON.parse(JSON.stringify(good()))
    bad[0].target.namespace = 'web'
    const problems = validateAssetLinks(bad)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('namespace')
  })

  it('names the field for an absent package', () => {
    const bad = JSON.parse(JSON.stringify(good()))
    delete bad[0].target.package_name
    const problems = validateAssetLinks(bad)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('package_name')
  })

  it('names the field for an empty package', () => {
    const bad = JSON.parse(JSON.stringify(good()))
    bad[0].target.package_name = ''
    expect(validateAssetLinks(bad)[0]).toContain('package_name')
  })

  it('names the field for an empty fingerprint list', () => {
    const bad = JSON.parse(JSON.stringify(good()))
    bad[0].target.sha256_cert_fingerprints = []
    const problems = validateAssetLinks(bad)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('sha256_cert_fingerprints')
  })

  it('names the field and the index for a malformed fingerprint', () => {
    const bad = JSON.parse(JSON.stringify(good()))
    bad[0].target.sha256_cert_fingerprints = [PLACEHOLDER, PLACEHOLDER.toLowerCase()]
    const problems = validateAssetLinks(bad)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('sha256_cert_fingerprints')
    expect(problems[0]).toContain('[1]')
  })

  it('reports every problem, not just the first', () => {
    const bad = JSON.parse(JSON.stringify(good()))
    bad[0].relation = []
    bad[0].target.namespace = 'web'
    bad[0].target.package_name = ''
    expect(validateAssetLinks(bad).length).toBe(3)
  })

  it('rejects a document that is not an array', () => {
    expect(validateAssetLinks({}).length).toBe(1)
    expect(validateAssetLinks(null).length).toBe(1)
    expect(validateAssetLinks('[]').length).toBe(1)
    expect(validateAssetLinks(undefined).length).toBe(1)
  })

  it('rejects an empty document — a statement list with no statements delegates nothing', () => {
    expect(validateAssetLinks([]).length).toBe(1)
  })

  it('rejects a statement that is not an object', () => {
    expect(validateAssetLinks([null]).length).toBe(1)
    expect(validateAssetLinks(['nope']).length).toBe(1)
    expect(validateAssetLinks([[]]).length).toBe(1)
  })

  it('rejects an absent target', () => {
    const bad = JSON.parse(JSON.stringify(good()))
    delete bad[0].target
    expect(validateAssetLinks(bad)[0]).toContain('target')
  })

  it('names the statement index so a two-statement file is debuggable', () => {
    const bad = JSON.parse(JSON.stringify([...good(), ...good()]))
    bad[1].target.namespace = 'web'
    const problems = validateAssetLinks(bad)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('[1]')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/invite/test/applinks.test.ts`

Expected: FAIL — the module does not exist yet, so Vite cannot resolve the import and no test runs:

```
Error: Failed to resolve import "../src/applinks" from "packages/invite/test/applinks.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/invite/src/applinks.ts`:

```ts
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
```

Then add one line to `packages/invite/src/index.ts`, keeping §4.8's order (`hex`, `uri`, `invite`, `t4t`, `reader`, `host`, `applinks`, `qr`, `qr-tables`) — the barrel exports all nine modules because all nine are pure and headless-safe:

```ts
export * from './applinks'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/invite/test/applinks.test.ts`
Expected: all tests pass.

Then the package typechecks under TS 5.9 strict with `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` and `isolatedModules`:

Run: `npm run typecheck --workspace @tapkart/invite`
Expected: no output, exit 0.

Then the whole suite, because the barrel changed:

Run: `npm test`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/invite/src/applinks.ts packages/invite/src/index.ts packages/invite/test/applinks.test.ts && git commit -m "feat(invite): App Links statement builder and validator (C-2)"
```
