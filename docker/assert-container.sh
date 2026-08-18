#!/usr/bin/env bash
# §12.2 assertions 30 and 31 over a built image.
# Usage: bash docker/assert-container.sh <image-tag>
set -euo pipefail

image="${1:?usage: assert-container.sh <image-tag>}"
port="${TAPKART_ASSERT_PORT:-3031}"
container="tapkart-assert-$$"
body_file="$(mktemp)"

# Obviously fake, format-valid values fixed by contract §1.
package="io.github.atvriders.tapkart"
placeholder="DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF"
# Exercise the complete list path, not just the first element. Repeating the one
# fingerprint the public repository is allowed to contain avoids inventing a
# second certificate identity merely for a fixture.
fingerprints="$placeholder,$placeholder"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -f "$body_file"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  docker logs "$container" 2>&1 | tail -40 >&2 || true
  exit 1
}

wait_for_health() {
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error "http://127.0.0.1:$port/healthz" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "== 30a. the container starts with both TAPKART_ variables set =="
docker run -d --name "$container" -p "127.0.0.1:$port:3031" \
  -e "TAPKART_ANDROID_PACKAGE=$package" \
  -e "TAPKART_SHA256_FINGERPRINTS=$fingerprints" \
  "$image" >/dev/null
wait_for_health || fail "the container never became healthy with App Links configured"

echo "== 30b. assetlinks.json is 200 application/json with no redirect =="
read -r code content_type redirects < <(
  curl --silent --show-error --max-redirs 0 -o "$body_file" \
    -w '%{http_code} %{content_type} %{num_redirects}\n' \
    "http://127.0.0.1:$port/.well-known/assetlinks.json"
) || fail "the assetlinks request failed"

[ "$code" = "200" ] || fail "expected assetlinks HTTP 200, got $code"
[ "$redirects" = "0" ] || fail "assetlinks redirected ($redirects hop(s)); the verifier follows no repair path"
case "$content_type" in
  application/json*) ;;
  *) fail "expected Content-Type application/json, got '$content_type'" ;;
esac

echo "== 30c. the body is exactly the configured, validated statement =="
PACKAGE="$package" FINGERPRINTS="$fingerprints" BODY_FILE="$body_file" \
  node --input-type=module - <<'NODE' || fail "the served assetlinks statement was not exact"
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const bundled = await build({
  stdin: {
    contents:
      "export { buildAssetLinks, parseFingerprintList, validateAssetLinks } from '@tapkart/invite'",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const source = bundled.outputFiles[0].text
const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`
const { buildAssetLinks, parseFingerprintList, validateAssetLinks } = await import(url)
const actual = JSON.parse(readFileSync(process.env.BODY_FILE, 'utf8'))
const expected = buildAssetLinks(
  process.env.PACKAGE,
  parseFingerprintList(process.env.FINGERPRINTS),
)
const problems = validateAssetLinks(actual)
if (problems.length > 0) throw new Error(problems.join('\n'))
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(
    `served body differs from configured statement\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`,
  )
}
console.log('  statement is valid and exact')
NODE

echo "== 31. the container also starts with no TAPKART_ variables =="
docker rm -f "$container" >/dev/null
docker run -d --name "$container" -p "127.0.0.1:$port:3031" "$image" >/dev/null
wait_for_health || fail "a self-hoster with no APK could not start the server"
docker logs "$container" 2>&1 | grep -q 'no assetlinks.json written' ||
  fail "the entrypoint did not explain why it wrote no assetlinks.json"

read -r code redirects < <(
  curl --silent --show-error --max-redirs 0 -o /dev/null \
    -w '%{http_code} %{num_redirects}\n' \
    "http://127.0.0.1:$port/.well-known/assetlinks.json"
) || fail "the no-APK assetlinks request failed"
[ "$code" = "404" ] || fail "expected no-APK assetlinks HTTP 404, got $code"
[ "$redirects" = "0" ] || fail "the no-APK assetlinks request redirected"

echo "OK: the image serves exact App Links metadata and supports the no-APK path."
