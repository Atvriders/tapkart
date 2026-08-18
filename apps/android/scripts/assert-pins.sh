#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android_dir="$(cd "$script_dir/.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pins="$("$android_dir/gradlew" -p "$android_dir" -q :app:printTapkartPins)"
get() {
  local key="$1" value
  value="$(printf '%s\n' "$pins" | sed -n "s/^$key=//p" | head -1)"
  [ -n "$value" ] || fail "printTapkartPins emitted no '$key'. Output was:
$pins"
  printf '%s' "$value"
}

application_id="$(get applicationId)"
namespace="$(get namespace)"
compile_sdk="$(get compileSdk)"
min_sdk="$(get minSdk)"
target_sdk="$(get targetSdk)"
android16="$(get android16ApiLevel)"

echo "== 1. compileSdk == targetSdk =="
[ "$compile_sdk" = "$target_sdk" ] ||
  fail "compileSdk ($compile_sdk) != targetSdk ($target_sdk) — §6.6"

echo "== 2. targetSdk >= the Android 16 API level =="
[ "$target_sdk" -ge "$android16" ] ||
  fail "targetSdk ($target_sdk) is below Android 16 API $android16"

echo "== 3. minSdk >= 26 =="
[ "$min_sdk" -ge 26 ] || fail "minSdk ($min_sdk) is below 26"

echo "== 4. the recorded Android 16 API level still matches the SDK =="
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$sdk_root" ] || fail "neither ANDROID_HOME nor ANDROID_SDK_ROOT is set"
found=""
for p in "$sdk_root"/platforms/*/source.properties; do
  [ -f "$p" ] || continue
  ver="$(sed -n 's/^Platform\.Version=//p' "$p")"
  api="$(sed -n 's/^AndroidVersion\.ApiLevel=//p' "$p")"
  case "$ver" in
    16|16.*) found="$api" ;;
  esac
done
[ -n "$found" ] || fail "no installed platform declares Platform.Version=16"
[ "$found" = "$android16" ] ||
  fail "recorded Android 16 API is $android16, installed SDK says $found"

echo "== 5. namespace == applicationId, and it is §1's value =="
[ "$namespace" = "$application_id" ] ||
  fail "namespace ($namespace) != applicationId ($application_id)"
[ "$application_id" = "io.github.atvriders.tapkart" ] ||
  fail "applicationId is '$application_id', not §1's fixed value"

echo "OK: compileSdk=$compile_sdk targetSdk=$target_sdk minSdk=$min_sdk android16=$android16"
