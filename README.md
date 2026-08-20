# Tapkart

Tapkart is a deterministic browser kart racer with solo bots, live multiplayer,
an installable offline PWA, and an Android NFC invite app. A host creates a
lobby; guests can tap the host phone, scan a QR code, or type the room code.

## Requirements

- Node.js **22 or newer** and npm.
- Chromium for the browser E2E lane (`npx playwright install chromium`).
- For Android: JDK 21 and an Android SDK containing Android 16 / API 36,
  platform-tools, and build-tools (including `adb` and `apksigner`). Set
  `JAVA_HOME` and either `ANDROID_HOME` or `ANDROID_SDK_ROOT` in your own
  environment; do not commit machine-specific SDK paths.
- Docker with Compose for the packaged self-host path.

Server configuration is defined once by the code and rendered in
[`docs/server-env.md`](docs/server-env.md). Unknown `TAPKART_` variables are
rejected so configuration typos fail at startup.

## Run locally

Install the locked workspace graph:

```bash
npm ci
```

For the complete web and multiplayer stack, build the web app before the server
bundle, then start the server from the repository root:

```bash
npm run build:server
npm run start -w @tapkart/server
```

Open `http://127.0.0.1:3031`. The same process serves the SPA, the health route,
and the `/ws` WebSocket endpoint. Re-run `npm run build:server` after source
changes. For quick solo-only frontend work, `npm run dev -w @tapkart/web` starts
Vite on port 5173; it does not proxy the multiplayer WebSocket server.

Useful local gates:

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The Playwright harness builds and starts its own web/server pair. Do not start a
second copy for that command.

## Multiplayer networking

Every player keeps a WebSocket connection to the Tapkart server for lobby
control, WebRTC signalling, the server shadow, and fallback relay traffic.
During a race, guests attempt direct host-star WebRTC data channels. If that
connection fails or times out, gameplay continues through the server's
WebSocket relay; a relay-first room still tries to upgrade guests when WebRTC
succeeds later.

The server runs a shadow authority for every v1 room. If the host disappears,
the shadow can be promoted and the remaining clients adopt its checkpoint.
`SHADOW_ENABLED=false` is rejected at startup: a relay-only race cannot complete
the v1 room lifecycle safely, so the server does not advertise that broken mode.

There is no TURN server in v1. `ICE_SERVERS` defaults to
`stun:stun.l.google.com:19302`, a **third-party STUN endpoint contacted at
connection time**. It learns the network addresses needed for ICE negotiation.
Set `ICE_SERVERS` to your own STUN service, or set it to an empty value to opt
out; without STUN, direct WebRTC may be limited to the same LAN, while the
WebSocket relay remains available. See
[`docs/server-env.md`](docs/server-env.md) for the exact syntax and defaults.

## PWA and offline behavior

`npm run build -w @tapkart/web` generates the manifest, icons, Vite bundle, and
root-scoped `sw.js`. After one successful connected load, the service worker can
reload the installed PWA offline and run a complete solo race against bots.
Offline multiplayer is not supported.

Service workers and installation require a secure context: use HTTPS in a real
deployment. Browsers make a development exception for loopback origins.

Lobby traffic, `/ws`, `/healthz`, APIs, signalling, and `/.well-known/` are
never served from the PWA cache. A waiting worker is not activated under a live
race; the app offers the update while idle or after the race ends. Whether an
install prompt appears remains a browser decision, so its absence is not by
itself a build failure.

## Self-hosting

One image serves the web app, WebSocket signalling/relay, room server, and
health endpoint. At startup it can also generate
`/.well-known/assetlinks.json` for an Android build.

```bash
curl -O https://raw.githubusercontent.com/Atvriders/tapkart/master/compose.yaml
docker compose up -d
curl --fail http://127.0.0.1:3031/healthz
```

The public image is `ghcr.io/atvriders/tapkart`. `latest` moves only for a
`v*` release tag; `edge` follows `master`; immutable `sha-<full-commit-sha>`
tags identify exact builds. The release and edge images target `linux/amd64`
and `linux/arm64`.

Put TLS and your own hostname in a reverse proxy or tunnel in front of port
3031. It must preserve WebSocket upgrades on `/ws`. The browser constructs
invite links from `location.origin`, so changing the web deployment's domain
does not require rebuilding the container.

### Configuration

Every server variable, type, default, and operational note lives in
[`docs/server-env.md`](docs/server-env.md); this README intentionally does not
duplicate that generated table. `compose.yaml` exposes the server on port 3031
and carries commented defaults for the common room, relay, ICE, and shadow
settings.

Two container-entrypoint values matter only when the deployment accompanies an
Android APK:

| Variable | What it must contain |
| --- | --- |
| `TAPKART_ANDROID_PACKAGE` | The APK's exact application ID. |
| `TAPKART_SHA256_FINGERPRINTS` | The complete comma- or whitespace-separated list of signing-certificate SHA-256 fingerprints. Put the released APK's signer first; every entry is validated and emitted in order. |

Set both through the host environment or an untracked Compose `.env` file before
`docker compose up -d`. With neither set, the server starts normally and does
not create `assetlinks.json`; a request for that path returns `404`, which is the
correct no-APK configuration. Setting only one, or supplying any malformed
fingerprint anywhere in the list, makes the entrypoint fail instead of serving a
misleading statement.

`TAPKART_ORIGIN` is deliberately **not** a container variable. It is needed only
when building a domain-specific Android APK. Ordinary browser deployments derive
their origin at runtime.

### Check the public well-known route

The container test proves loopback behavior; your TLS proxy or tunnel is outside
that proof. After deploying an APK-enabled image, run against the public origin:

```bash
curl -I https://tapkart.example/.well-known/assetlinks.json
curl --fail --silent --show-error https://tapkart.example/.well-known/assetlinks.json
```

Expect a direct `200`, `content-type: application/json`, and no redirect at all,
including no trailing-slash redirect. Then complete the on-device checks in
[`docs/owner-verification.md`](docs/owner-verification.md).

## Build the Android app

### Prebuilt APKs

Two are published, and the difference between them is not cosmetic.

The **debug APK** is attached to every successful `master` CI run as the
`tapkart-debug-apk` artifact (Actions → the run → Artifacts). It installs and
plays, and NFC, QR, and room-code joins all work. It is signed with Android's
universal debug key, so App Links will **not** verify: a tapped invite opens
the browser rather than the app. It is also built against this repository's
reserved example origin, not a deployment.

The **signed release APK** is attached to each GitHub Release, built by
`release.yml` from a `v*` tag. That one is signed with the project keystore and
compiled against the deployed origin, so invites route into the app. Producing
it requires the owner's keystore secrets and the release repository variables —
see [In CI](#in-ci).

Build it yourself when you want a different origin:

The Android project is a flat Capacitor workspace under `apps/android`. Its APK
bundles `apps/web/dist`; it never loads the game from a remote WebView. Build the
web assets with the same HTTPS origin Gradle will compile into both App Links
intent filters:

```bash
export TAPKART_ORIGIN=https://tapkart.example
VITE_TAPKART_ORIGIN="$TAPKART_ORIGIN" npm run build -w @tapkart/web
npm run sync -w @tapkart/android
apps/android/gradlew -p apps/android :app:testDebugUnitTest :app:assembleDebug
bash apps/android/scripts/assert-pins.sh
node apps/android/scripts/assert-manifest.mjs debug
```

Replace the reserved example origin in your local environment with the HTTPS
origin that will serve this APK's `assetlinks.json`; never commit the real host.
The debug APK is written under
`apps/android/app/build/outputs/apk/debug/`. The `gradlew` wrapper lives at
`apps/android/gradlew`, so invoke it exactly as shown from the repository root.

The APK can host an NFC Type 4 Tag invite and can read another host's invite
while the guest is on a join-capable screen. Hosting requires NFC/HCE, an
unlocked screen, and the app in the foreground. The advert and reader mode are
cleared when the activity pauses. QR and typed room-code joins remain available
on devices without NFC. For a publishable build, continue to
[Signing the Android app](#signing-the-android-app).

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
string goes in the `TAPKART_SHA256_FINGERPRINTS` **repository variable** used by
release CI and in the deployment environment variable of the same name. The
container turns the deployment value into `/.well-known/assetlinks.json` at
start-up. It is a variable rather than a secret because it is published to the
world in that file by design.

`TAPKART_SHA256_FINGERPRINTS` is a **list**. The release certificate must be the
first entry because release CI compares that entry to the APK it is about to
publish. Additional entries allow other deliberately trusted certificates, such
as an owner's local debug certificate, to verify against the same domain. The
release workflow parses and validates the **entire** list and rejects an empty
list, any malformed or duplicate fingerprint, and the repository placeholder;
the container preserves the normalized order in `assetlinks.json`.

### Build a signed release locally

Four environment variables, read by Gradle at build time:

| Variable | Value |
|---|---|
| `TAPKART_KEYSTORE_PATH` | absolute path to the keystore — outside this checkout |
| `TAPKART_KEYSTORE_PASSWORD` | the store password |
| `TAPKART_KEY_ALIAS` | the key alias, e.g. `tapkart` |
| `TAPKART_KEY_PASSWORD` | the key password |

```bash
export TAPKART_ORIGIN=https://tapkart.example
VITE_TAPKART_ORIGIN="$TAPKART_ORIGIN" npm run build -w @tapkart/web
npm run sync -w @tapkart/android
apps/android/gradlew -p apps/android :app:assembleRelease
node apps/android/scripts/assert-manifest.mjs release
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

The workflow maps repository secrets to the Gradle-only environment; these are
different names on purpose:

| Repository secret | Gradle environment |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Decoded under `$RUNNER_TEMP`; its resulting path becomes `TAPKART_KEYSTORE_PATH`. |
| `ANDROID_KEYSTORE_PASSWORD` | `TAPKART_KEYSTORE_PASSWORD` |
| `ANDROID_KEY_ALIAS` | `TAPKART_KEY_ALIAS` |
| `ANDROID_KEY_PASSWORD` | `TAPKART_KEY_PASSWORD` |

The release workflow rejects an empty or reserved example origin, checks the
configured package against Gradle's frozen
`io.github.atvriders.tapkart` application ID, validates every fingerprint, and
builds both copies of the web assets from the configured origin. It decodes
`ANDROID_KEYSTORE_BASE64` under `$RUNNER_TEMP` with restrictive permissions —
never into the workspace — points `TAPKART_KEYSTORE_PATH` at it, builds, and
asserts that the certificate `apksigner` prints equals the normalized first
entry of `TAPKART_SHA256_FINGERPRINTS`. The keystore is never uploaded.

Release signing and the `latest` image happen only for `v*` tags, because pull
requests and ordinary branch builds have no release credentials. The tag's
GitHub Release receives `app-release.apk` and `release-manifest.json`; `master`
publishes only `edge`. The validation workflow also supports a manual
`workflow_dispatch` run in addition to push and pull-request triggers.

Never commit the keystore, its base64, its passwords, or its real fingerprint.
`bash apps/android/scripts/assert-signing.sh` checks the parts of that a machine
can check.

Before trusting a release, follow all fifteen owner-only checks in
[`docs/owner-verification.md`](docs/owner-verification.md), including App Links,
real NFC contact, QR scanning, offline PWA startup, audio, and keystore backups.
