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

echo "== 1. complete signing variables select signingConfigs.release =="
probe_path="${TMPDIR:-/tmp}/tapkart-signing-assertion-does-not-exist.jks"
report="$(
  env \
    TAPKART_KEYSTORE_PATH="$probe_path" \
    TAPKART_KEYSTORE_PASSWORD=assertion-only \
    TAPKART_KEY_ALIAS=assertion-only \
    TAPKART_KEY_PASSWORD=assertion-only \
    "$android_dir/gradlew" -p "$android_dir" :app:signingReport
)"
release_config="$(
  printf '%s\n' "$report" |
    awk '/^Variant: release$/ { found = 1; next } found && /^Config:/ { print $2; exit }'
)"
if [ "$release_config" != "release" ]; then
  printf '%s\n' "$report" >&2
  fail "the release variant reported \"Config: ${release_config:-<none found>}\", not \"release\".
  §6.5 requires complete TAPKART_KEYSTORE_* input to select signingConfigs.release.
  Without it every CI build carries a different auto-generated debug certificate and
  no static assetlinks.json can ever match — spec §2's silent App Links failure."
fi

echo "== 2. no signing variables leave release unsigned =="
unsigned_report="$(
  env \
    -u TAPKART_KEYSTORE_PATH \
    -u TAPKART_KEYSTORE_PASSWORD \
    -u TAPKART_KEY_ALIAS \
    -u TAPKART_KEY_PASSWORD \
    "$android_dir/gradlew" -p "$android_dir" :app:signingReport
)"
unsigned_config="$(
  printf '%s\n' "$unsigned_report" |
    awk '/^Variant: release$/ { found = 1; next } found && /^Config:/ { print $2; exit }'
)"
if [ "$unsigned_config" != "null" ] && [ "$unsigned_config" != "none" ]; then
  printf '%s\n' "$unsigned_report" >&2
  fail "the no-credentials release variant reported Config: ${unsigned_config:-<none found>}, not null"
fi

echo "== 3. the debug variant is not what release is signed with =="
debug_config="$(
  printf '%s\n' "$report" |
    awk '/^Variant: debug$/ { found = 1; next } found && /^Config:/ { print $2; exit }'
)"
if [ "$debug_config" = "release" ]; then
  fail "the debug variant is using the release signing config"
fi

echo "== 4. no keystore path points inside the working tree =="
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

echo "== 5. keystores cannot be committed by accident =="
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

echo "== 6. the build file carries no key material =="
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
