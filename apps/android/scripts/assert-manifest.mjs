#!/usr/bin/env node
//
// §12.2 assertions 19-24, over the MERGED manifest — not the source one, because
// AGP merges elements in from every library and the file that matters is the one
// that ends up in the APK.
//
// Run:  node apps/android/scripts/assert-manifest.mjs [debug|release]
// After: apps/android/gradlew -p apps/android :app:assemble<Variant>
//
import { build } from 'esbuild'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ANDROID_DIR = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const MANIFEST_VARIANT = (process.argv[2] ?? 'debug').trim().toLowerCase()

if (!/^[a-z][a-z0-9_-]*$/.test(MANIFEST_VARIANT)) {
  console.error(
    `FAIL: manifest variant '${MANIFEST_VARIANT}' is not a Gradle variant name.\n` +
      '  Usage: node apps/android/scripts/assert-manifest.mjs [debug|release]',
  )
  process.exit(1)
}

const problems = []
function check(ok, message) {
  if (!ok) problems.push(message)
}

/* ---------------------------------------------------------------- constants */

/** The two shipped values, read from the packages that own them. C-1: the
 *  prefix has exactly ONE source, and a test that compared the manifest against
 *  a string typed here would prove the two strings agree with each other, which
 *  is the defect this assertion exists to prevent. */
async function shippedConstants() {
  const bundled = await build({
    stdin: {
      contents:
        "export { LOBBY_PATH_PREFIX } from '@tapkart/protocol'\n" +
        "export { originHost } from '@tapkart/invite'\n",
      resolveDir: REPO_ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  })
  const source = bundled.outputFiles[0].text
  const url = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64')
  const mod = await import(url)
  if (typeof mod.LOBBY_PATH_PREFIX !== 'string' || mod.LOBBY_PATH_PREFIX.length === 0) {
    throw new Error('LOBBY_PATH_PREFIX did not resolve from @tapkart/protocol')
  }
  if (typeof mod.originHost !== 'function') {
    throw new Error('originHost did not resolve from @tapkart/invite')
  }
  return mod
}

/* ------------------------------------------------------------- a tiny parser */

/** A scanner, not a regex sweep: an XML attribute value may legally contain
 *  '>', and a `<[^>]*>` pattern silently truncates the tag when it does. No
 *  dependency is added for this — contract §0's whole posture is that a
 *  supply-chain edge must buy more than it costs, and an AGP-generated manifest
 *  is well-formed XML with no entities, no CDATA and no namespaces beyond the
 *  android one. */
function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [] }
  const stack = [root]
  let elements = 0
  let i = 0
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt < 0) break
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt)
      i = end < 0 ? text.length : end + 3
      continue
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt)
      i = end < 0 ? text.length : end + 2
      continue
    }
    let j = lt + 1
    let quote = ''
    while (j < text.length) {
      const c = text[j]
      if (quote !== '') {
        if (c === quote) quote = ''
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') {
        break
      }
      j++
    }
    const raw = text.slice(lt + 1, j)
    i = j + 1
    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const nameMatch = /^\s*([^\s/>]+)/.exec(body)
    if (nameMatch === null) continue
    const node = { name: nameMatch[1], attrs: {}, children: [] }
    const attrRe = /([A-Za-z_][-A-Za-z0-9_.:]*)\s*=\s*("([^"]*)"|'([^']*)')/g
    let m
    while ((m = attrRe.exec(body)) !== null) {
      node.attrs[m[1]] = m[3] !== undefined ? m[3] : m[4]
    }
    elements++
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }
  return { root, elements }
}

function descendants(node, name, out = []) {
  for (const child of node.children) {
    if (child.name === name) out.push(child)
    descendants(child, name, out)
  }
  return out
}

function actionNames(filter) {
  return descendants(filter, 'action').map((a) => a.attrs['android:name'])
}

function categoryNames(filter) {
  return descendants(filter, 'category').map((c) => c.attrs['android:name'])
}

/* ------------------------------------------------- finding the merged manifest */

function findMergedManifests() {
  const intermediates = join(ANDROID_DIR, 'app', 'build', 'intermediates')
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name === 'AndroidManifest.xml') {
        const lower = p.replaceAll('\\', '/').toLowerCase()
        // AGP has moved this path between majors. Match on what it MEANS rather
        // than on one version's spelling, and assert on every match, so a layout
        // change is a louder failure than a silent zero-file pass.
        if (
          lower.includes('/merged_manifest') &&
          lower.split('/').includes(MANIFEST_VARIANT)
        ) found.push(p)
      }
    }
  }
  walk(intermediates)
  return found
}

/* --------------------------------------------------------------- assertions */

const { LOBBY_PATH_PREFIX, originHost } = await shippedConstants()

const BUILD_ORIGIN = process.env.TAPKART_ORIGIN ?? 'https://tapkart.example'
const EXPECTED_HOST = originHost(BUILD_ORIGIN)
if (EXPECTED_HOST === null) {
  console.error(
    `FAIL: TAPKART_ORIGIN='${BUILD_ORIGIN}' is not an https origin, so originHost() returns null.\n` +
      '  §3 value 1: the intent filter\'s host comes from this variable and nothing else.',
  )
  process.exit(1)
}

const manifests = findMergedManifests()
if (manifests.length === 0) {
  console.error(
    `FAIL: no merged ${MANIFEST_VARIANT} manifest found under apps/android/app/build/intermediates/.\n` +
      `  Run 'apps/android/gradlew -p apps/android :app:assemble${MANIFEST_VARIANT[0].toUpperCase()}${MANIFEST_VARIANT.slice(1)}' first. ` +
      'An assertion script that\n' +
      '  passes when it found nothing to assert on is this project\'s signature defect.',
  )
  process.exit(1)
}

for (const path of manifests) {
  const { root, elements } = parseXml(readFileSync(path, 'utf8'))
  const manifest = descendants(root, 'manifest')[0]
  check(manifest !== undefined, `${path}: no <manifest> element — the parser found nothing`)
  check(elements > 10, `${path}: only ${elements} elements parsed; the manifest is not this small`)
  if (manifest === undefined) continue

  const filters = descendants(manifest, 'intent-filter')

  // 19. Exactly one autoVerify filter, and every attribute App Links requires.
  const verified = filters.filter((f) => f.attrs['android:autoVerify'] === 'true')
  check(verified.length === 1, `${path}: ${verified.length} intent-filters carry autoVerify="true", expected exactly 1`)
  if (verified.length === 1) {
    const f = verified[0]
    check(actionNames(f).includes('android.intent.action.VIEW'), `${path}: the autoVerify filter has no VIEW action`)
    const cats = categoryNames(f)
    check(cats.includes('android.intent.category.DEFAULT'), `${path}: the autoVerify filter has no DEFAULT category`)
    check(cats.includes('android.intent.category.BROWSABLE'), `${path}: the autoVerify filter has no BROWSABLE category`)
    const data = descendants(f, 'data')
    check(data.length === 1, `${path}: the autoVerify filter has ${data.length} <data> elements, expected 1`)
    if (data.length === 1) {
      check(data[0].attrs['android:scheme'] === 'https', `${path}: the autoVerify filter's scheme is not https`)
      check(
        (data[0].attrs['android:host'] ?? '') !== '',
        `${path}: the autoVerify filter has an empty host`,
      )
      check(
        data[0].attrs['android:pathPrefix'] === LOBBY_PATH_PREFIX,
        `${path}: pathPrefix is '${data[0].attrs['android:pathPrefix']}', but LOBBY_PATH_PREFIX is ` +
          `'${LOBBY_PATH_PREFIX}'. C-1 freezes this at the first signed release; a mismatch opens a ` +
          'browser instead of the app, silently, forever.',
      )
    }
  }

  // 20. Exactly one NDEF_DISCOVERED filter, same data, and no autoVerify (F-P5-16).
  const ndef = filters.filter((f) => actionNames(f).includes('android.nfc.action.NDEF_DISCOVERED'))
  check(ndef.length === 1, `${path}: ${ndef.length} intent-filters carry NDEF_DISCOVERED, expected exactly 1`)
  if (ndef.length === 1) {
    const f = ndef[0]
    check(
      f.attrs['android:autoVerify'] === undefined,
      `${path}: the NDEF_DISCOVERED filter carries autoVerify — it is not an App Link and verification does not apply to it`,
    )
    check(categoryNames(f).includes('android.intent.category.DEFAULT'), `${path}: the NDEF filter has no DEFAULT category`)
    const data = descendants(f, 'data')
    check(data.length === 1, `${path}: the NDEF filter has ${data.length} <data> elements, expected 1`)
    if (data.length === 1) {
      check(data[0].attrs['android:scheme'] === 'https', `${path}: the NDEF filter's scheme is not https`)
      check(
        data[0].attrs['android:pathPrefix'] === LOBBY_PATH_PREFIX,
        `${path}: the NDEF filter's pathPrefix does not equal LOBBY_PATH_PREFIX`,
      )
    }
  }

  // F-P5-16, structurally: "both filters deliver the same URI to the same
  // handler. It is one path with two entry points." Same host, same prefix, and
  // — the part a data comparison alone would miss — the same <activity>.
  if (verified.length === 1 && ndef.length === 1) {
    const activities = descendants(manifest, 'activity')
    const ownerOf = (filter) =>
      activities.find((a) => descendants(a, 'intent-filter').includes(filter))
    const a1 = ownerOf(verified[0])
    const a2 = ownerOf(ndef[0])
    check(a1 !== undefined && a1 === a2, `${path}: the two filters are not on the same <activity> — that is two code paths, not one`)
    if (a1 !== undefined) {
      check(
        a1.attrs['android:launchMode'] === 'singleTask',
        `${path}: the invite activity's launchMode is '${a1.attrs['android:launchMode']}', not singleTask. ` +
          'Without it a verified App Link opened while the app is running starts a SECOND task and the ' +
          'guest lands on a fresh title screen instead of the lobby they were invited to.',
      )
    }
    const h1 = descendants(verified[0], 'data')[0]?.attrs['android:host']
    const h2 = descendants(ndef[0], 'data')[0]?.attrs['android:host']
    check(h1 === h2, `${path}: the two filters name different hosts ('${h1}' and '${h2}')`)

    // 21. The host equals originHost(TAPKART_ORIGIN) for this build.
    check(
      h1 === EXPECTED_HOST,
      `${path}: the manifest host is '${h1}', but originHost('${BUILD_ORIGIN}') is '${EXPECTED_HOST}'. ` +
        '§3 values 1 and 2 must agree or the tap opens a browser.',
    )
  }

  // 22. The HCE service.
  const services = descendants(manifest, 'service')
  const hce = services.filter((s) => (s.attrs['android:name'] ?? '').endsWith('TapkartHceService'))
  check(hce.length === 1, `${path}: ${hce.length} TapkartHceService declarations, expected exactly 1`)
  if (hce.length === 1) {
    const s = hce[0]
    check(
      s.attrs['android:permission'] === 'android.permission.BIND_NFC_SERVICE',
      `${path}: TapkartHceService is not guarded by BIND_NFC_SERVICE`,
    )
    check(s.attrs['android:exported'] === 'true', `${path}: TapkartHceService is not exported`)
    check(
      actionNames(s).includes('android.nfc.cardemulation.action.HOST_APDU_SERVICE'),
      `${path}: TapkartHceService has no HOST_APDU_SERVICE action`,
    )
    const meta = descendants(s, 'meta-data').find(
      (m) => m.attrs['android:name'] === 'android.nfc.cardemulation.host_apdu_service',
    )
    check(meta !== undefined, `${path}: TapkartHceService has no host_apdu_service meta-data`)
    check(
      meta?.attrs['android:resource'] === '@xml/apduservice',
      `${path}: host_apdu_service meta-data points at '${meta?.attrs['android:resource']}', not @xml/apduservice`,
    )
  }

  // 24. Every component with an intent filter declares android:exported.
  for (const kind of ['activity', 'service', 'receiver', 'provider']) {
    for (const c of descendants(manifest, kind)) {
      if (descendants(c, 'intent-filter').length === 0) continue
      check(
        c.attrs['android:exported'] === 'true' || c.attrs['android:exported'] === 'false',
        `${path}: <${kind} android:name="${c.attrs['android:name']}"> has an intent filter and no explicit android:exported`,
      )
    }
  }

  // The permissions and features §6.2 fixes. required="false" on both is
  // deliberate: only the HOST needs NFC, and a guest with a non-NFC phone must
  // still be able to install the APK and play.
  const permissions = descendants(manifest, 'uses-permission').map((p) => p.attrs['android:name'])
  check(permissions.includes('android.permission.NFC'), `${path}: android.permission.NFC is not requested`)
  check(permissions.includes('android.permission.INTERNET'), `${path}: android.permission.INTERNET is not requested`)
  for (const feature of ['android.hardware.nfc', 'android.hardware.nfc.hce']) {
    const f = descendants(manifest, 'uses-feature').find((x) => x.attrs['android:name'] === feature)
    check(f !== undefined, `${path}: <uses-feature ${feature}> is absent`)
    check(
      f?.attrs['android:required'] === 'false',
      `${path}: <uses-feature ${feature}> is required, which excludes every non-NFC phone from installing`,
    )
  }
}

// 23. apduservice.xml — a source resource, not a merged one.
{
  const path = join(ANDROID_DIR, 'app', 'src', 'main', 'res', 'xml', 'apduservice.xml')
  const { root } = parseXml(readFileSync(path, 'utf8'))
  const service = descendants(root, 'host-apdu-service')[0]
  check(service !== undefined, `${path}: no <host-apdu-service> element`)
  check(
    service?.attrs['android:requireDeviceUnlock'] === 'true',
    `${path}: requireDeviceUnlock is not "true". Spec §2 states the limit — "the host's screen must be ` +
      'on and unlocked for HCE to respond" — and widening it is a spec amendment, not a manifest attribute.',
  )
  const filters = descendants(root, 'aid-filter')
  check(filters.length === 1, `${path}: ${filters.length} <aid-filter> elements, expected exactly 1`)
  check(
    filters[0]?.attrs['android:name'] === 'D2760000850101',
    `${path}: the AID is '${filters[0]?.attrs['android:name']}', not the NFC Forum NDEF Type 4 application D2760000850101`,
  )
}

if (problems.length > 0) {
  console.error('FAIL: the manifest does not satisfy §12.2 assertions 19-24:')
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nNone of these produce a runtime error on a phone. A failed App Link verification is silent on\n' +
      'Android 12+: the tap opens a browser instead of the app, with no message anywhere.',
  )
  process.exit(1)
}

console.log(
  `OK: ${manifests.length} merged ${MANIFEST_VARIANT} manifest(s) checked; ` +
    `pathPrefix='${LOBBY_PATH_PREFIX}', host='${EXPECTED_HOST}'.`,
)
