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

/** Derive a distinct valid value without writing a second fingerprint literal. */
const placeholderBytes = PLACEHOLDER.split(':')
const PLACEHOLDER_2 = [...placeholderBytes.slice(1), placeholderBytes[0]].join(':')

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
