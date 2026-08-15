### Task 14: `AndroidManifest.xml`, `apduservice.xml`, and the structural assertions over the merged manifest

**Files:**
- Modify: `apps/android/app/src/main/AndroidManifest.xml` — §6.2's two intent filters, the HCE service, the permissions and the features
- Create: `apps/android/app/src/main/res/xml/apduservice.xml` — §6.3, verbatim
- Modify: `apps/android/app/src/main/res/values/strings.xml` — the two strings `apduservice.xml` names
- Modify: `apps/android/app/build.gradle.kts` — `manifestPlaceholders` for the host and the path prefix (§13's sole-writer row)
- Create: `apps/android/scripts/write-invite-constants.mjs` — emits the generated properties file below
- Create: `apps/android/gradle/invite-constants.properties` — **generated and committed**; the one place Gradle learns the invite path prefix
- Create: `apps/android/scripts/assert-manifest.mjs` — §12.2 assertions 19–24
- Modify: `package.json` (root) — `esbuild` as a devDependency (§8.7, P5 Q30)
- Modify: `package-lock.json` — the `npm install` side effect

**Ordering:** after **Task 13** (the scaffold — this task edits files it creates) and after **Task 11** (the manifest names `.nfc.TapkartHceService` and `.MainActivity`, and `assembleDebug` will not compile a manifest pointing at a class nobody has written). The Android execution order Task 13 fixes is **13 → 10 → 11 → 14 → 12**.

**Interfaces:**

- **Consumes** — `LOBBY_PATH_PREFIX` from `@tapkart/protocol`, and `originHost` from `@tapkart/invite` (Task 3). Both are read by the two Node scripts, never retyped:

  ```ts
  /** The lobby URL path prefix, exported ONCE (C-1). Compiled into the Android
   *  APK's `autoVerify` intent-filter `pathPrefix`. FROZEN AT THE FIRST SIGNED
   *  RELEASE. */
  export const LOBBY_PATH_PREFIX = '/r/'

  /** 'https://tapkart.example' -> 'tapkart.example'. null on anything that is not
   *  an https origin. */
  export function originHost(origin: string): string | null
  ```

- **Consumes** — Task 13's Gradle property and Task 11's two class names:

  ```
  tapkartApplicationId                                        (gradle.properties)
  io.github.atvriders.tapkart.MainActivity                    (Task 13, replaced by Task 11)
  io.github.atvriders.tapkart.nfc.TapkartHceService           (Task 11)
  ```

- **Produces** — no exported symbol; §16's census is unchanged. It produces two declaration files, one generated properties file, and the assertion script the `android` CI job runs.

**The failure this task exists to prevent, and it produces no error anywhere.** Spec §2, quoted in contract §3: *"on Android 12+ a failed verification is silent — no disambiguation chooser, the link just opens in the browser."* The guest is never blocked, because the QR and the room code are always on screen, so **nothing about a broken App Link is loud**. It just quietly stops being an app. One wrong character in `pathPrefix`, one stale host, one missing `android:exported`, and every tap on every Android 12-or-newer phone opens a browser tab, forever, with no log line and no failing test.

That is why this task's verification is a script and not a comment. §12.2 numbers six structural assertions over the **merged** manifest — not the source one, because AGP merges in `<uses-permission>` and `<activity>` elements from every library, and the file that matters is the one that ends up in the APK.

**What this task proves, and what it does not.** This is the boundary spec §8 sets and §14 restates, and it is worth stating before writing a line of it:

| CI can prove, and this script does | CI cannot prove |
|---|---|
| Exactly one filter carries `autoVerify`, and it has `VIEW`, `DEFAULT`, `BROWSABLE`, `scheme="https"`, a non-empty host, and a `pathPrefix` **equal to the constant imported from `@tapkart/protocol`** | That Android's verifier succeeded. It runs on-device, against the real domain, for the installed certificate |
| Exactly one filter carries `NDEF_DISCOVERED`, with the same scheme, host and prefix, and **no** `autoVerify` | That a real Android 15 phone raises `NDEF_DISCOVERED` for our emulated tag. The OS decides which intent a tag raises |
| Both filters sit on **the same activity**, which is what "same URI, same handler" means structurally | That the tap works at all. HCE needs two physical devices in antenna contact |
| The host equals `originHost(TAPKART_ORIGIN)` for this build | That the origin the owner deploys is that container |
| The HCE service is declared with `BIND_NFC_SERVICE`, `exported="true"`, the `HOST_APDU_SERVICE` action and the `host_apdu_service` meta-data | That the service ever answers a real reader |
| `apduservice.xml` has exactly one `aid-filter`, `D2760000850101`, with `requireDeviceUnlock="true"` | That the AID is not also claimed by another installed app on the owner's phone |
| Every component with an intent filter declares `android:exported` explicitly | — |

Everything in the right column is in `docs/owner-verification.md` (§14.1) and nowhere else. **A task that claims CI proves the tap works is lying** — this one claims CI proves the declarations are right, which is a different and smaller sentence.

**Why the path prefix is generated rather than typed.** §6.2: *"The two `pathPrefix` values are **generated from `LOBBY_PATH_PREFIX`**, not typed: §12.2's assertion compares the merged manifest's value against the constant imported from `@tapkart/protocol`, which is what makes C-1's freeze mechanical."* Both halves are built here: a generator writes the constant into a properties file Gradle reads, and the assertion re-reads the constant from the package and compares. Either alone would be a convention; together they are a mechanism.

**Why the host is derived in Gradle and cross-checked in Node.** §13's sole-writer table: *"`manifestPlaceholders["tapkartHost"]` — `apps/android/app/build.gradle.kts`, from `tapkartOrigin` — no other file names a host."* Gradle does the one-line derivation because a build has no Node in it; assertion 21 then recomputes the same host with the real shipped `originHost` and fails if they differ. That is the same shape as the prefix: one writer, one independent check.

---

- [ ] **Step 1: Write the failing test**

**1a.** Declare `esbuild`, which both scripts in this task use to read a TypeScript constant from Node. P5 Q30, in the contract's words: *"`esbuild` is a declared root devDependency: Plan 3's content gate already invokes it, declaring a binary you execute is correct, and relying on a transitive Vite dependency is how a major bump breaks the deploy."*

```bash
npm install --save-dev --workspaces=false esbuild@latest
```

**1b.** Create `apps/android/scripts/assert-manifest.mjs`:

```js
#!/usr/bin/env node
//
// §12.2 assertions 19-24, over the MERGED manifest — not the source one, because
// AGP merges elements in from every library and the file that matters is the one
// that ends up in the APK.
//
// Run:  node apps/android/scripts/assert-manifest.mjs
// After: ./gradlew -p apps/android :app:assembleDebug
//
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ANDROID_DIR = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

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
        const lower = p.toLowerCase()
        // AGP has moved this path between majors. Match on what it MEANS rather
        // than on one version's spelling, and assert on every match, so a layout
        // change is a louder failure than a silent zero-file pass.
        if (lower.includes('merged_manifest') && lower.includes('debug')) found.push(p)
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
    'FAIL: no merged debug manifest found under apps/android/app/build/intermediates/.\n' +
      "  Run './gradlew -p apps/android :app:assembleDebug' first. An assertion script that\n" +
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
  `OK: ${manifests.length} merged manifest(s) checked; pathPrefix='${LOBBY_PATH_PREFIX}', host='${EXPECTED_HOST}'.`,
)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./gradlew -p apps/android :app:assembleDebug && node apps/android/scripts/assert-manifest.mjs`

Expected: **FAIL**. The Capacitor template's manifest has a launcher activity and nothing else — no App Links filter, no NDEF filter, no NFC permission, no HCE service:

```
FAIL: the manifest does not satisfy §12.2 assertions 19-24:
  - …/AndroidManifest.xml: 0 intent-filters carry autoVerify="true", expected exactly 1
  - …/AndroidManifest.xml: 0 intent-filters carry NDEF_DISCOVERED, expected exactly 1
  - …/AndroidManifest.xml: 0 TapkartHceService declarations, expected exactly 1
  - …/AndroidManifest.xml: android.permission.NFC is not requested
  - …/AndroidManifest.xml: <uses-feature android.hardware.nfc> is absent
  - …/AndroidManifest.xml: <uses-feature android.hardware.nfc.hce> is absent
```

The `apduservice.xml` block throws `ENOENT` before those, since the file does not exist yet; create it first (Step 3b) if you want the full list in one run.

- [ ] **Step 3: Write the implementation**

**3a.** Create `apps/android/scripts/write-invite-constants.mjs`. This is the "generated, not typed" half of §6.2:

```js
#!/usr/bin/env node
//
// Emits apps/android/gradle/invite-constants.properties from the SHIPPED
// constants, so Gradle never contains a second spelling of them.
//
// C-1: "So it is ONE exported constant, and lobbyPathFor, resolveRoute, the
// invite-URI builder, the QR payload, the web manifest and the intent-filter
// template all read it. Not two constants that agree today."
//
// The output is committed, because Gradle must be able to configure on a fresh
// checkout with no Node run first — Tasks 10, 11 and 12 all invoke ./gradlew.
// CI regenerates it and fails on any diff, which is what keeps a committed
// generated file honest.
//
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const OUT = fileURLToPath(new URL('../gradle/invite-constants.properties', import.meta.url))

const bundled = await build({
  stdin: {
    contents: "export { LOBBY_PATH_PREFIX } from '@tapkart/protocol'\n",
    resolveDir: REPO_ROOT,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const url =
  'data:text/javascript;base64,' +
  Buffer.from(bundled.outputFiles[0].text, 'utf8').toString('base64')
const { LOBBY_PATH_PREFIX } = await import(url)

if (typeof LOBBY_PATH_PREFIX !== 'string' || !LOBBY_PATH_PREFIX.startsWith('/')) {
  throw new Error(`LOBBY_PATH_PREFIX is not a path: ${String(LOBBY_PATH_PREFIX)}`)
}

const body = `# GENERATED by apps/android/scripts/write-invite-constants.mjs — do not hand-edit.
#
# C-1: the invite path prefix has exactly one source, LOBBY_PATH_PREFIX in
# @tapkart/protocol, and it is FROZEN AT THE FIRST SIGNED RELEASE. It is
# compiled into the APK's autoVerify intent-filter pathPrefix; a mismatch is
# spec §2's silent App Links failure — the tap opens a browser instead of the
# app, with no error anywhere.
tapkartLobbyPathPrefix=${LOBBY_PATH_PREFIX}
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, body, 'utf8')
console.log(`wrote ${OUT}: tapkartLobbyPathPrefix=${LOBBY_PATH_PREFIX}`)
```

Run it once: `node apps/android/scripts/write-invite-constants.mjs`

It writes `apps/android/gradle/invite-constants.properties`, whose body today is that header plus `tapkartLobbyPathPrefix=/r/`. **Commit the generated file.**

**3b.** Create `apps/android/app/src/main/res/xml/apduservice.xml` — contract §6.3, verbatim:

```xml
<?xml version="1.0" encoding="utf-8"?>
<host-apdu-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/hce_service_description"
    android:requireDeviceUnlock="true">
  <aid-group android:description="@string/hce_aid_group_description"
             android:category="other">
    <aid-filter android:name="D2760000850101"/>
  </aid-group>
</host-apdu-service>
```

`requireDeviceUnlock="true"` (P5 Q15) matches spec §2's stated limit — *"The host's screen must be on and unlocked for HCE to respond"* — rather than quietly widening it. Changing it is a spec amendment, not a manifest attribute. `D2760000850101` is the NFC Forum registered NDEF Type 4 Tag application, and it is the same seven bytes `NDEF_AID` carries in TypeScript (Task 4) and `T4tTag.AID` carries in Kotlin (Task 10).

**3c.** In `apps/android/app/src/main/res/values/strings.xml`, add the two strings `apduservice.xml` names, keeping every string the template already put there:

```xml
    <string name="hce_service_description">Tapkart lobby invite</string>
    <string name="hce_aid_group_description">NFC Forum NDEF tag</string>
```

These are user-visible in Android's *Tap and pay* settings screen, which is the only place a `host-apdu-service` description appears.

**3d.** In `apps/android/app/build.gradle.kts`, inside `android { defaultConfig { … } }`, add the two manifest placeholders. Keep everything Task 13 put there:

```kotlin
        // §13's sole-writer row: manifestPlaceholders["tapkartHost"] is written
        // HERE, from tapkartOrigin, and no other file names a host.
        //
        // §3 value 1: the host in the autoVerify filter and the origin the APK's
        // WebView builds invite URIs from are the SAME variable (§3 value 2), and
        // C-3/F-P5-11 make it build-time because an intent filter is compiled
        // into the APK and can never be runtime-configurable.
        //
        // The default is §1's reserved RFC 2606 domain, deliberately: a local
        // debug build must configure without an origin, and a reserved domain is
        // one that CANNOT accidentally verify against a real site. The release
        // job always sets TAPKART_ORIGIN, and assertion 21 compares the merged
        // manifest against originHost() of whatever it was.
        val tapkartOrigin =
            (findProperty("tapkartOrigin") as String?)
                ?: System.getenv("TAPKART_ORIGIN")
                ?: "https://tapkart.example"
        check(tapkartOrigin.startsWith("https://")) {
            "tapkartOrigin must be an https origin (got '$tapkartOrigin'). The intent filter's " +
                "scheme is https and nothing else will ever match it."
        }
        val tapkartHost = tapkartOrigin.removePrefix("https://").substringBefore('/')
        check(tapkartHost.isNotEmpty() && !tapkartHost.contains('/')) {
            "tapkartOrigin '$tapkartOrigin' does not yield a host"
        }

        // §6.2: the two pathPrefix values are GENERATED from LOBBY_PATH_PREFIX,
        // not typed. This file is written by scripts/write-invite-constants.mjs
        // and CI fails on any diff after regenerating it.
        val inviteConstants = java.util.Properties()
        file("${'$'}{rootDir}/gradle/invite-constants.properties").inputStream().use {
            inviteConstants.load(it)
        }
        val tapkartLobbyPathPrefix =
            inviteConstants.getProperty("tapkartLobbyPathPrefix")
                ?: error(
                    "gradle/invite-constants.properties has no tapkartLobbyPathPrefix. " +
                        "Run: node apps/android/scripts/write-invite-constants.mjs",
                )

        manifestPlaceholders["tapkartHost"] = tapkartHost
        manifestPlaceholders["tapkartPathPrefix"] = tapkartLobbyPathPrefix
```

**3e.** Edit `apps/android/app/src/main/AndroidManifest.xml`. **Keep every attribute the generated file already carries** on `<manifest>`, `<application>` and the `<provider>` — the theme, the label, the icons and the FileProvider authority are the template's and this task changes none of them.

Add these four elements as direct children of `<manifest>`, outside `<application>`:

```xml
    <uses-permission android:name="android.permission.NFC"/>
    <uses-permission android:name="android.permission.INTERNET"/>
    <uses-feature android:name="android.hardware.nfc" android:required="false"/>
    <uses-feature android:name="android.hardware.nfc.hce" android:required="false"/>
```

`required="false"` on both, deliberately: only the **host** needs NFC, and a guest with a non-NFC phone must still be able to install the APK and play. Marking the feature required would exclude them from the install. (The template already declares `INTERNET`; a duplicate `uses-permission` is merged, not an error, but delete the template's line rather than shipping two.)

On the existing `<activity android:name=".MainActivity">`, set these five attributes — replacing the template's `configChanges` value with §6.2's exact list:

```xml
        android:name=".MainActivity"
        android:exported="true"
        android:launchMode="singleTask"
        android:screenOrientation="sensorLandscape"
        android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
```

`launchMode="singleTask"` is required, not cosmetic: without it, a verified App Link opened while the app is already running starts a *second* task and the guest lands on a fresh title screen instead of the lobby they were invited to.

Inside that same `<activity>`, keep the template's MAIN/LAUNCHER filter and add these two beneath it:

```xml
      <!-- Entry point 1: App Links. The ONLY path that works on Android 16+. -->
      <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW"/>
        <category android:name="android.intent.category.DEFAULT"/>
        <category android:name="android.intent.category.BROWSABLE"/>
        <data android:scheme="https" android:host="${tapkartHost}" android:pathPrefix="${tapkartPathPrefix}"/>
      </intent-filter>

      <!-- Entry point 2 (F-P5-16): catches the app-installed case on Android 15
           and earlier, where an NDEF tag still fires ACTION_NDEF_DISCOVERED.
           Four lines. Same URI, same handler, same code path — asserted by
           §7.3's uriFrom in Kotlin and by this filter sitting on this activity. -->
      <intent-filter>
        <action android:name="android.nfc.action.NDEF_DISCOVERED"/>
        <category android:name="android.intent.category.DEFAULT"/>
        <data android:scheme="https" android:host="${tapkartHost}" android:pathPrefix="${tapkartPathPrefix}"/>
      </intent-filter>
```

The second filter carries **no** `autoVerify` — it is not an App Link and verification does not apply to it.

Then add the HCE service as the last child of `<application>`:

```xml
    <service
        android:name=".nfc.TapkartHceService"
        android:exported="true"
        android:permission="android.permission.BIND_NFC_SERVICE">
      <intent-filter>
        <action android:name="android.nfc.cardemulation.action.HOST_APDU_SERVICE"/>
      </intent-filter>
      <meta-data
          android:name="android.nfc.cardemulation.host_apdu_service"
          android:resource="@xml/apduservice"/>
    </service>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./gradlew -p apps/android :app:assembleDebug && node apps/android/scripts/assert-manifest.mjs`
Expected:

```
OK: 1 merged manifest(s) checked; pathPrefix='/r/', host='tapkart.example'.
```

Then prove the host really does follow the variable rather than a baked string:

Run: `TAPKART_ORIGIN=https://kart.example.com ./gradlew -p apps/android :app:assembleDebug && TAPKART_ORIGIN=https://kart.example.com node apps/android/scripts/assert-manifest.mjs`
Expected: `OK: … host='kart.example.com'.` — §1's second example origin, and the two halves of §3 agreeing under a value neither of them has seen before.

Then prove the assertion detects a wrong prefix, because an assertion nobody has watched fail is an assertion nobody knows works. Temporarily replace `${tapkartPathPrefix}` with `/j/` — the stale prefix C-1 ruled against — in the `autoVerify` filter, rebuild, and run the script:

Expected: FAIL with

```
  - …/AndroidManifest.xml: pathPrefix is '/j/', but LOBBY_PATH_PREFIX is '/r/'. C-1 freezes this at
    the first signed release; a mismatch opens a browser instead of the app, silently, forever.
```

Put `${tapkartPathPrefix}` back and confirm green.

Then the generated file must be reproducible, which is what makes committing it safe:

Run: `node apps/android/scripts/write-invite-constants.mjs && git diff --exit-code apps/android/gradle/invite-constants.properties`
Expected: exit 0, no diff.

Then the rest of the Android module must still be green, since this task changed the manifest every Kotlin test compiles against:

Run: `./gradlew -p apps/android :app:testDebugUnitTest && bash apps/android/scripts/assert-pins.sh`
Expected: pass, and Task 13's five pin checks still `OK`.

Run: `npx vitest run`
Expected: the whole suite green — `no-secrets.test.ts` now also scans `apduservice.xml`, `AndroidManifest.xml` and the generated properties file, none of which contains a host, an address or a fingerprint.

**Six things this task did not prove, and they are §14.1's, items 1 and 4 to 8:** that Android's verifier succeeded against the real domain; that a guest without the app lands in a browser lobby; that a guest with the app foregrounded joins in-app; that a backgrounded guest routes into the app rather than the browser; that an Android 15 phone raises the second filter at all; and that a cold start lands in the lobby rather than the title screen. Every one needs a phone.

- [ ] **Step 5: Commit**

```bash
git add apps/android/app/src/main/AndroidManifest.xml apps/android/app/src/main/res apps/android/app/build.gradle.kts apps/android/gradle/invite-constants.properties apps/android/scripts/write-invite-constants.mjs apps/android/scripts/assert-manifest.mjs package.json package-lock.json && git commit -m "feat(android): App Links + NDEF filters, the HCE service declaration, and the structural assertions (§6.2, §6.3, F-P5-16)"
```
