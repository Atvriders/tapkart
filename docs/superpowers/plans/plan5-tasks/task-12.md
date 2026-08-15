### Task 12: signing — a stable keystore from the first build

**Files:**
- Create: `apps/android/scripts/assert-signing.sh`
- Modify: `apps/android/app/build.gradle.kts` — `signingConfigs`, the release build type, two configuration-time guards
- Modify: `README.md` — a `## Signing the Android app` section
- Modify: `.gitignore` — §1's keystore entries, if an earlier task has not already added them

**Ordering:** this task writes into the `apps/android` Capacitor project — `app/build.gradle.kts`, `app/src/main/kotlin/`, `app/src/test/kotlin/`. That project, its Gradle wrapper, its manifest and its version pins (§6.1, §6.6) are the **Android scaffold task's**, so run this after it. If `apps/android/gradlew` does not exist yet, that is the missing prerequisite and not a defect in this task.

**This is a day-one requirement, not a v2 migration, and it is the single most expensive thing in the plan to get wrong.** Spec §2, quoted in §6.5:

> Gradle auto-generates `~/.android/debug.keystore` when absent, and a GitHub Actions runner is a fresh VM every run, so every CI build would carry a different certificate and no static `assetlinks.json` could ever match.

Read that with §3's table beside it. Value 5 is `sha256_cert_fingerprints[0]`, which must equal the SHA-256 of the certificate in the keystore that signed the **installed** APK. If the certificate changes every build, that value can never be written down, so App Links can never verify — and spec §2 again:

> on Android 12+ a failed verification is **silent** — no disambiguation chooser, the link just opens in the browser.

There is no error, no log line and no failing test. The tap simply stops being an app and starts being a browser tab, and the only way anyone finds out is a human holding a phone. That is why signing is wired before the first release build rather than after the first complaint, and why §14.1's checklist item 15 is *"Confirm the keystore backup exists, in two places, before the first release tag is pushed."*

**The second half of the same requirement: the key must survive.** Spec §11 lists *"Losing the signing keystore"* as a risk in its own right, because a lost key cannot be regenerated — a new one has a new fingerprint, so every installed copy stops verifying and `assetlinks.json` has to be rewritten. Backed up on the day it is created, in two places, neither of which is this repository.

**What this task does not touch.** `.github/workflows/release.yml` is a later task's file (§12.1). This task documents exactly what that job must do with the four secrets, in the README, where a self-hoster building their own APK also needs it. It also does not write the `apk` job's fingerprint assertion (§12.2 assertion 28) — it makes that assertion *possible* by giving the build a stable certificate to assert about.

**Interfaces:**

- **Consumes** — the environment, and nothing else. §6.5 fixes the four names Gradle reads:

  ```kotlin
  signingConfigs {
      create("release") {
          storeFile = System.getenv("TAPKART_KEYSTORE_PATH")?.let(::file)
          storePassword = System.getenv("TAPKART_KEYSTORE_PASSWORD")
          keyAlias = System.getenv("TAPKART_KEY_ALIAS")
          keyPassword = System.getenv("TAPKART_KEY_PASSWORD")
      }
  }
  ```

  And the CI secret and variable names §12.1 fixes:

  ```
  Secrets:   ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD,
             ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD
  Variables: TAPKART_ORIGIN, TAPKART_ANDROID_PACKAGE, TAPKART_SHA256_FINGERPRINTS
  ```

  A fingerprint is a **variable, not a secret** (P5 Q35): it is published to the world inside `assetlinks.json` by design. §1 forbids it in a repo *file*; a CI variable is not a file.

- **Produces:** no exported symbol. This task's output is a build configuration, an assertion script and a documented procedure — §16's census is unchanged by it.

**A cross-plan hazard this task must not create, recorded because §2.5 and §18.1 already pay for the same shape once.** Plan 4's `parseConfig` *"throws on an unknown variable with the prefix `TAPKART_`, because that prefix is ours and a typo in it is always a mistake."* The four variables above carry that prefix and are read by **Gradle, on a build machine** — never by the server, never inside the container. They must therefore never appear in `Dockerfile`, `compose.yaml` or `ENV_SCHEMA`: the container that sets `TAPKART_KEYSTORE_PATH` is a container whose server refuses to start. §11.4's drift test asserts the container files name exactly `ENV_SCHEMA ∪ ASSETLINKS_ENV_VARS`, and these four are in neither set, so that test is what keeps this honest — provided nobody "helpfully" adds them.

**The placeholder rule, at its sharpest.** §1: the keystore is *"never in the repo, in any form, at any size. Not the file, not base64 of it, not its passwords, not its real fingerprint."* The only fingerprint that may be written anywhere in this repository is `DE:AD:BE:EF:…` (§1). **A signing key committed once is compromised forever** — rotating it means every installed APK stops verifying — so this task adds a mechanical check rather than trusting care.

---

- [ ] **Step 1: Write the failing test**

Create `apps/android/scripts/assert-signing.sh`:

```bash
#!/usr/bin/env bash
#
# §6.5's signing wiring, asserted mechanically.
#
# Run from anywhere:  bash apps/android/scripts/assert-signing.sh
# Needs the Android SDK, because it asks Gradle what it is actually configured
# to do rather than reading the build file and hoping. In CI this runs in the
# `android` job (§12.1), which has the SDK.
#
# It does NOT require a keystore to exist: a fork's pull request has no secrets,
# and a build with no keystore env must still configure, build, and produce an
# UNSIGNED release APK that CI then rejects at the fingerprint check (§12.2
# assertion 28) rather than shipping.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$android_dir/../.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "== 1. the release variant uses signingConfigs.release =="
report="$("$android_dir/gradlew" -p "$android_dir" :app:signingReport)"
release_config="$(
  printf '%s\n' "$report" |
    awk '/^Variant: release$/ { found = 1; next } found && /^Config:/ { print $2; exit }'
)"
if [ "$release_config" != "release" ]; then
  printf '%s\n' "$report" >&2
  fail "the release variant reported \"Config: ${release_config:-<none found>}\", not \"release\".
  §6.5 requires signingConfigs.release, fed from the TAPKART_KEYSTORE_* environment.
  Without it every CI build carries a different auto-generated debug certificate and
  no static assetlinks.json can ever match — spec §2's silent App Links failure."
fi

echo "== 2. the debug variant is not what release is signed with =="
debug_config="$(
  printf '%s\n' "$report" |
    awk '/^Variant: debug$/ { found = 1; next } found && /^Config:/ { print $2; exit }'
)"
if [ "$debug_config" = "release" ]; then
  fail "the debug variant is using the release signing config"
fi

echo "== 3. no keystore path points inside the working tree =="
if [ -n "${TAPKART_KEYSTORE_PATH:-}" ]; then
  store_dir="$(cd "$(dirname "$TAPKART_KEYSTORE_PATH")" && pwd)"
  case "$store_dir/" in
    "$repo_root"/*)
      fail "TAPKART_KEYSTORE_PATH is inside the repository working tree ($store_dir).
  §6.5: in CI the keystore is decoded to \$RUNNER_TEMP, NEVER into the workspace.
  One 'git add -A' from inside the tree publishes a signing key forever."
      ;;
  esac
fi

echo "== 4. keystores cannot be committed by accident =="
for candidate in \
  "apps/android/app/release.jks" \
  "apps/android/app/release.keystore" \
  "apps/android/app/release.p12" \
  "apps/android/keystore.properties" \
  "apps/android/local.properties" \
  "local.properties"; do
  if ! git -C "$repo_root" check-ignore -q "$candidate"; then
    fail "$candidate is not ignored by .gitignore — see contract §1's list"
  fi
done

echo "== 5. the build file carries no key material =="
gradle_file="$android_dir/app/build.gradle.kts"
if grep -nE '(storePassword|keyPassword|keyAlias)[[:space:]]*=[[:space:]]*"' "$gradle_file"; then
  fail "a literal credential is written in $gradle_file — §1 permits none, ever"
fi
if grep -nE 'storeFile[[:space:]]*=[[:space:]]*file\("' "$gradle_file"; then
  fail "a literal keystore path is written in $gradle_file — §1 permits none, ever"
fi
if grep -nE '([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}' "$gradle_file" |
  grep -v 'DE:AD:BE:EF'; then
  fail "a certificate fingerprint that is not §1's placeholder appears in $gradle_file"
fi

echo "OK: signing is wired to the environment, and nothing about the key is in the repo."
```

Make it executable: `chmod +x apps/android/scripts/assert-signing.sh`

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash apps/android/scripts/assert-signing.sh`

Expected: FAIL at check 1. The Capacitor template ships no `signingConfigs`, so Gradle reports no signing configuration for the release variant:

```
== 1. the release variant uses signingConfigs.release ==
…
Variant: release
Config: none
…
FAIL: the release variant reported "Config: none", not "release".
  §6.5 requires signingConfigs.release, fed from the TAPKART_KEYSTORE_* environment.
```

(The script prints the whole `signingReport` output before failing, so if a Gradle version words the line differently the actual text is right there rather than guessed at.)

- [ ] **Step 3: Write the implementation**

**3a.** In `apps/android/app/build.gradle.kts`, inside the existing `android { }` block, add the signing configuration exactly as §6.5 fixes it — and wire the release build type to it. Keep every other setting the template already put in `buildTypes.release` unchanged:

```kotlin
    signingConfigs {
        create("release") {
            // §6.5. Four environment variables, no file in the repository, no
            // Gradle property that could end up in a properties file, no default.
            // A build with none of them set produces an UNSIGNED release APK, and
            // CI fails it at §12.2's fingerprint check rather than shipping it.
            storeFile = System.getenv("TAPKART_KEYSTORE_PATH")?.let(::file)
            storePassword = System.getenv("TAPKART_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("TAPKART_KEY_ALIAS")
            keyPassword = System.getenv("TAPKART_KEY_PASSWORD")
        }
    }

    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
        }
        // The debug build type keeps Gradle's auto-generated debug keystore and
        // is never released (§6.5). Its certificate is the owner's local machine's
        // and therefore never enters this repository — if the owner wants a debug
        // build to verify App Links too, its fingerprint goes in
        // TAPKART_SHA256_FINGERPRINTS, which is a LIST for exactly that reason.
    }
```

**3b.** At the top level of the same file, after the `android { }` block, add the two guards that cannot be skipped — they run at configuration time, so every `./gradlew` invocation in CI and on a developer's machine evaluates them, including `testDebugUnitTest`:

```kotlin
// §6.5, guard 1: the release variant must be signed with the release config.
// Without this the wiring can be deleted and nothing fails until an owner
// installs an APK whose App Links silently do not verify.
afterEvaluate {
    val configured = android.buildTypes.getByName("release").signingConfig?.name
    check(configured == "release") {
        "the release build type must use signingConfigs.release (found: ${configured ?: "none"}) " +
            "— see README, 'Signing the Android app'"
    }
}

// §6.5, guard 2: the keystore is decoded to $RUNNER_TEMP in CI and lives outside
// the checkout on the owner's machine. A signing key committed once is
// compromised forever, so this is a build failure and not a warning.
System.getenv("TAPKART_KEYSTORE_PATH")?.let { path ->
    val store = File(path).canonicalFile
    val tree = rootProject.projectDir.canonicalFile
    check(!store.path.startsWith(tree.path + File.separator)) {
        "TAPKART_KEYSTORE_PATH points inside the Gradle project tree ($store) — " +
            "keep the keystore outside the checkout, and out of the repository forever"
    }
}
```

`java.io.File` is already in scope in a Gradle Kotlin DSL script; if the file has an imports block, add `import java.io.File` to it.

**3c.** In `.gitignore`, make sure §1's entries are present. An earlier task may already have added them — the list is idempotent, and check 4 of the script is what proves it either way:

```gitignore
*.jks
*.keystore
*.p12
keystore.properties
local.properties
apps/android/local.properties
```

**3d.** In `README.md`, add this section. The self-host section, the link to `docs/server-env.md` and the STUN disclosure sentence are a **different** task's edits to the same file (§11.7) — do not write them here.

````markdown
## Signing the Android app

The APK must be signed by **the same certificate every time, starting with the
first build you ever release.** This is not a release-day chore; it is what makes
the NFC tap work at all.

Android verifies an App Link by fetching `/.well-known/assetlinks.json` from your
domain and comparing the certificate fingerprint it finds there against the
certificate of the installed app. Gradle generates a throwaway debug keystore
whenever one is missing, and a CI runner is a fresh machine every run — so
without a stable keystore, every build carries a different certificate, no
fingerprint can ever be written down, and verification always fails.

**And on Android 12 and newer, a failed verification is silent.** There is no
chooser and no error: the tap just opens a browser instead of the app. Nothing in
the logs, nothing in CI. Assume it is broken until you have checked it on a phone
(`docs/owner-verification.md`, items 1 and 2).

### Create the keystore, once

Run this **outside** this repository — the keystore must never be inside the
checkout, in any form, at any size:

```bash
keytool -genkeypair -v \
  -keystore tapkart-release.jks \
  -alias tapkart \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Tapkart, OU=Tapkart, O=Tapkart, L=Example, ST=Example, C=US"
```

`keytool` prompts for the passwords. Do not pass them on the command line: they
end up in your shell history.

### Back it up the day you create it, in two places

A lost signing key cannot be regenerated. A new key has a new fingerprint, so
every installed copy stops verifying and `assetlinks.json` has to be rewritten
and redeployed. Two backups, neither of them this repository, before the first
release tag is pushed.

### Read the fingerprint

```bash
keytool -list -v -keystore tapkart-release.jks -alias tapkart | grep 'SHA256:'
```

It prints 32 hex bytes separated by colons — 95 characters, upper case. That
string is what goes in the `TAPKART_SHA256_FINGERPRINTS` **repository variable**,
which the container turns into `/.well-known/assetlinks.json` at start-up. It is
a variable rather than a secret because it is published to the world in that file
by design.

`TAPKART_SHA256_FINGERPRINTS` is a **list**: if you also want a locally built
debug APK to verify against your domain, add your debug certificate's fingerprint
beside the release one, separated by a comma.

### Build a signed release locally

Four environment variables, read by Gradle at build time:

| Variable | Value |
|---|---|
| `TAPKART_KEYSTORE_PATH` | absolute path to the keystore — outside this checkout |
| `TAPKART_KEYSTORE_PASSWORD` | the store password |
| `TAPKART_KEY_ALIAS` | the key alias, e.g. `tapkart` |
| `TAPKART_KEY_PASSWORD` | the key password |

```bash
./gradlew -p apps/android :app:assembleRelease
apksigner verify --print-certs apps/android/app/build/outputs/apk/release/app-release.apk
```

With none of them set, the build still succeeds and produces
`app-release-unsigned.apk`. That is deliberate: a pull request from a fork has no
secrets, so it must still build — and CI rejects the unsigned artifact at the
fingerprint check rather than publishing it.

> **These four variables are for build machines only.** They begin with
> `TAPKART_`, which is also the prefix the server's configuration parser owns, and
> that parser rejects any `TAPKART_` variable it does not recognise. Never set
> them in the container's environment, in `compose.yaml`, or in the Dockerfile.

### In CI

Repository **secrets**: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
Repository **variables**: `TAPKART_ORIGIN`, `TAPKART_ANDROID_PACKAGE`,
`TAPKART_SHA256_FINGERPRINTS`.

The release workflow decodes `ANDROID_KEYSTORE_BASE64` into `$RUNNER_TEMP` — never
into the workspace — points `TAPKART_KEYSTORE_PATH` at it, builds, and then
asserts that the certificate `apksigner` prints equals the first entry of
`TAPKART_SHA256_FINGERPRINTS`. The keystore is never uploaded as an artifact.
Release signing happens on `v*` tags only, because a pull request from a fork has
no access to secrets.

Never commit the keystore, its base64, its passwords, or its real fingerprint.
`bash apps/android/scripts/assert-signing.sh` checks the parts of that a machine
can check.
````

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash apps/android/scripts/assert-signing.sh`
Expected:

```
== 1. the release variant uses signingConfigs.release ==
== 2. the debug variant is not what release is signed with ==
== 3. no keystore path points inside the working tree ==
== 4. keystores cannot be committed by accident ==
== 5. the build file carries no key material ==
OK: signing is wired to the environment, and nothing about the key is in the repo.
```

Then prove the no-keystore path really does build rather than failing a fork's pull request — with none of the four variables set:

Run: `env -u TAPKART_KEYSTORE_PATH -u TAPKART_KEYSTORE_PASSWORD -u TAPKART_KEY_ALIAS -u TAPKART_KEY_PASSWORD ./gradlew -p apps/android :app:assembleRelease && ls apps/android/app/build/outputs/apk/release/`
Expected: BUILD SUCCESSFUL, and the directory contains **`app-release-unsigned.apk`** — the unsigned artifact CI is meant to reject, not a silently debug-signed one.

Then confirm the guards fire when the wiring is wrong, because a guard nobody has seen fail is a guard nobody knows works:

Run: `TAPKART_KEYSTORE_PATH="$PWD/apps/android/app/tapkart-release.jks" ./gradlew -p apps/android :app:tasks`
Expected: FAIL with `TAPKART_KEYSTORE_PATH points inside the Gradle project tree` — then unset it and confirm the build configures again.

Then the rest of the Android module must still be green:

Run: `./gradlew -p apps/android :app:testDebugUnitTest`
Expected: pass.

And the repository-wide secret scan, which is §1's test and owns the general case:

Run: `npm test`
Expected: pass, including `packages/invite/test/no-secrets.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/android/scripts/assert-signing.sh apps/android/app/build.gradle.kts .gitignore README.md && git commit -m "feat(android): stable release signing from the environment, asserted (§6.5)"
```
