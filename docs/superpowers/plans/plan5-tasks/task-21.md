### Task 21: `docs/owner-verification.md` and the README's self-host section

**Files:**
- Create: `docs/owner-verification.md` — contract §14 and §14.1
- Modify: `README.md` — the self-host section, the link to `docs/server-env.md`, the STUN disclosure, and the C-3 sentence (§11.7)

**Ordering:** last. It documents what every other task built, and its `curl` and `adb` invocations name paths and variables that must already exist.

**Interfaces:**

- **Consumes** — nothing executable. It names, and must agree with:

  ```
  compose.yaml                      (Task 19)   the file a self-hoster runs
  docs/server-env.md                (Plan 4)    the ONE env table, generated from ENV_SCHEMA
  README.md § Signing the Android app (Task 12) keystore generation and backup
  /.well-known/assetlinks.json      (Task 19)   generated at container start
  ghcr.io/atvriders/tapkart:latest  (Task 20)   moved by v* tags only (F-P5-33)
  ```

- **Produces** — no exported symbol.

**Why this file is a deliverable and not a courtesy.** Spec §8's *What CI cannot verify* names two things and says both are owner-verified; spec §2's *Known limits (stated, not hidden)* names four more. §14 is the complete list for Plan 5, and it is *"written to be **read against** §12.2: everything mechanical is there, everything below is not."*

> **This contract does not claim CI proves the NFC tap works. It claims CI proves the bytes are right.** Those are different sentences and the difference is the whole point of §5.

The checklist is **fixed in §14.1** *"so a task cannot quietly shorten it"* — fifteen numbered items, and this task ships all fifteen. Two of them (9 and 10) exist to confirm that something **does not** work: they are documented limits, and confirming a limit is confirming the documentation.

**Three things this task must not do.**

1. **No fourth copy of the environment table** (§11.4, §18.3). Plan 4 ships `docs/server-env.md` from `formatEnvTable()` and asserts it byte for byte; the README **links** to it. *"Three copies checked against one schema (C-6) is already the maximum a test can keep honest."* A README table would be a fourth place the variable list is written, checked by nothing.
2. **No duplication of Task 12's signing section.** §11.7 lists keystore generation among the README's additions; Task 12 already wrote it, in full, under `## Signing the Android app`. This task **links to it** and adds the sections Task 12 explicitly left alone: *"The self-host section, the link to `docs/server-env.md` and the STUN disclosure sentence are a **different** task's edits to the same file (§11.7) — do not write them here."*
3. **No real host, anywhere.** §1: `tapkart.example` and `192.0.2.10` / `198.51.100.7` / `203.0.113.4` only, and `127.0.0.1` where a loopback is meant. `packages/invite/test/no-secrets.test.ts` (Task 13) greps every tracked file, and this task writes the two files most likely to acquire a real domain by habit.

---

- [ ] **Step 1: Write the documents**

There is no failing test here, and inventing one would be worse than saying so: a document has no behaviour to assert, and a test that greps prose for a phrase pins the phrase, not the truth of it. Step 2's checks are structural — the item count, the absence of a table, the absence of a real host — and Step 3 is the only verification that matters, which is a human with a phone actually working through the list.

**1a.** Create `docs/owner-verification.md`:

````markdown
# Owner verification

Everything in this file is something **CI cannot prove**. It is not a smoke test
and it is not optional: three of the failures below produce no error message
anywhere — no log line, no crash, no failing test — and the only way anyone finds
out is by holding a phone.

Work through it after the first `v*` tag, and again whenever the deployed origin,
the signing keystore or the `applicationId` changes.

## Why this file exists

Spec §2, on the failure this whole project is shaped around:

> On Android 12+ a failed App Links verification is **silent** — no
> disambiguation chooser, the link just opens in the browser.

The guest is never blocked, because the QR and the room code are always on screen
beside the tap prompt. So nothing about a broken App Link is loud. It just
quietly stops being an app.

## What CI does prove, so you know what not to re-check

| Proven mechanically | How |
|---|---|
| Every APDU byte, in **both** languages | `processApdu` and `T4tTag.process` replay one shared fixture, `packages/invite/vectors/t4t-exchange.tsv` |
| The NDEF file the tag serves, byte for byte | `ndef-uri.tsv`, replayed by both languages |
| The reader and the tag agree | `readInvite` driven against `processApdu` over an in-memory transceive |
| The manifest's App Links filter | exactly one `autoVerify`, with `VIEW`, `DEFAULT`, `BROWSABLE`, `https`, a non-empty host, and a `pathPrefix` equal to the shipped `LOBBY_PATH_PREFIX` |
| The second entry point | exactly one `NDEF_DISCOVERED` filter, same scheme, host and prefix, no `autoVerify`, on the same activity |
| The APK's certificate | `apksigner verify --print-certs` equals the first entry of `TAPKART_SHA256_FINGERPRINTS` |
| The APK's `applicationId` | equals `TAPKART_ANDROID_PACKAGE` |
| The container's `assetlinks.json` | 200, `application/json`, **no redirect**, and a body the shipped validator accepts |
| Offline solo | Playwright goes offline, reloads, and a solo race starts and runs |
| The QR symbol | matches a published reference symbol module for module |

## What CI cannot prove, and why

| Cannot be verified in CI | Why |
|---|---|
| **The NFC tap** | HCE requires two physical devices in antenna contact |
| **App Links verification** | Android's verifier runs on-device, against the real domain, for the installed certificate |
| **That the deployed origin serves your container** | The tunnel config is yours and its hostname is not in this repository |
| **That the second entry point fires on a real Android 15 phone** | The OS decides which intent an NDEF tag raises |
| **That the host's screen stays on, and antenna alignment** | Physical |
| **Android 17+ notification-tap flow** | OS behaviour on an OS version no runner has |
| **iPhone background reading of an emulated tag** | Good, but not universal across models and OS versions |
| **That audio sounds like an engine** | Judgement, on a speaker |
| **That the QR scans** | A camera, a screen, and lighting |
| **That the install prompt appears** | Chrome's engagement heuristics |
| **How the game feels on a phone** | Nothing mechanical touches this |

## The checklist

You need: the deployed origin reachable over HTTPS, the release APK from the
GitHub Release, a host phone with NFC, and at least one guest phone. Items 7 and
11 need specific hardware and are recorded as "not available" if you do not have
it — **not** ticked.

1. **Install the release APK** (not a debug build) on the host phone, then
   confirm Android verified the App Links:

   ```bash
   adb shell pm get-app-links io.github.atvriders.tapkart
   ```

   Expect your deployed host listed as `verified`. Anything else — `legacy_failure`,
   `1024` (no response), `1025` (bad response) — means the tap will open a
   browser. Re-run verification with:

   ```bash
   adb shell pm verify-app-links --re-verify io.github.atvriders.tapkart
   ```

2. **Fetch the statement through the real tunnel**, not on loopback. The
   container test proves the container; the tunnel, the proxy and any
   trailing-slash normalisation are outside that proof and inside yours:

   ```bash
   curl -I https://tapkart.example/.well-known/assetlinks.json
   ```

   Expect `HTTP/2 200` and `content-type: application/json`. **Any 3xx is a
   failure**, including a redirect to the same URL with a trailing slash: the
   Android verifier does not follow redirects for this file.

   Then confirm the fingerprint in it is the one that signed the APK you just
   installed:

   ```bash
   curl -s https://tapkart.example/.well-known/assetlinks.json
   ```

3. **Host a lobby.** Confirm the QR, the room code and the tap prompt are on
   screen **at the same time**. Spec §2 requires all three together — nobody is
   ever blocked from joining, and a tap that fails must cost a guest a QR scan
   rather than the race.

4. **Tap a guest that does not have the app.** Expect the browser to open the
   lobby (Android 16 and earlier), or a notification that opens it (Android 17+).

5. **Tap a guest that has the app, foregrounded.** Expect the join to happen
   in-app, with no browser.

6. **Tap a guest that has the app, backgrounded.** Expect App Links to route into
   the app, not the browser.

7. **Tap a guest running Android 15 or earlier**, if you have one. This is the
   row the second intent filter exists for. If you have no such device, record
   "not available".

8. **Cold start.** With the app **not running at all**, tap. Expect the app to
   launch *into the lobby*, not the title screen. This is the single most likely
   real tap in the product, and it is the only thing that checks
   `getPendingInvite`: a cold-start App Link is delivered before any JavaScript
   has run, so no listener can have been registered yet.

9. **Tap with the host's screen locked.** Expect **nothing to happen.** This is
   the documented limit — HCE does not answer with the screen off or locked — and
   confirming it is confirming the documentation.

10. **Tap with the host app backgrounded.** Expect **nothing to happen.** This is
    deliberate, not a defect: the advert is cleared on pause, because *a tap that
    fails the same way every time is debuggable and explainable to a guest; one
    that works only while the screen happens to be on is neither.*

11. **Tap with an iPhone XS or newer.** Record the model and the iOS version
    beside the result — background tag reading is good but not universal across
    models and OS versions, so the result is data, not a pass or a fail.

12. **The two paths that never depend on NFC.** Scan the QR from a second phone
    at arm's length, and type the room code in by hand. Both must work. Neither
    is CI-checkable, and together they are the reason a failed tap is an
    inconvenience rather than an exclusion.

13. **Airplane mode.** Put the phone in airplane mode, open the **installed**
    PWA, and confirm it loads and a solo race runs against bots. CI proves this
    in a desktop browser; this proves it on the device that matters.

14. **Listen to it.** Confirm the engine pitch tracks speed, and that item,
    impact and lap sounds fire. Every number in `ONE_SHOT_SPECS`
    (`packages/render/src/audio/graph.ts`) is a first draft with a reason written
    beside it; CI proves only that the op list is exactly right, which says
    nothing about whether any of it sounds like a kart. Tune the numbers here.

15. **Confirm the keystore backup exists, in two places**, before the first
    release tag is pushed. A lost signing key cannot be regenerated: a new key
    has a new fingerprint, so every installed copy stops verifying and
    `assetlinks.json` has to be rewritten and redeployed. See
    [README § Signing the Android app](../README.md#signing-the-android-app).

## If item 1 says anything but `verified`

In order of how often each one is the cause:

1. The host in the APK's intent filter is not the host you deployed. It is baked
   in at build time from `TAPKART_ORIGIN` and cannot be changed without
   rebuilding — check the repository variable the release workflow used.
2. `TAPKART_SHA256_FINGERPRINTS` in the deployment is not the certificate that
   signed the installed APK. Read the installed one with
   `apksigner verify --print-certs` on the APK you actually installed.
3. `/.well-known/assetlinks.json` redirects, or is served with the wrong content
   type, somewhere between the tunnel and the container. Item 2 is that check.
4. `TAPKART_ANDROID_PACKAGE` does not equal the APK's `applicationId`.

All four are silent. None of them logs anything on the phone, and the app keeps
working perfectly — it just opens in a browser.
````

**1b.** Add these sections to `README.md`. Do **not** touch the `## Signing the Android app` section — Task 12 owns it in full.

````markdown
## Self-hosting

One container. It serves the web app, the WebSocket signalling and the room
server, and it generates `/.well-known/assetlinks.json` at start-up.

```bash
curl -O https://raw.githubusercontent.com/Atvriders/tapkart/master/compose.yaml
docker compose up -d
```

The image is `ghcr.io/atvriders/tapkart:latest`, multi-arch (`linux/amd64`,
`linux/arm64`) and public. **`latest` means a tagged release.** If you want the
head of `master` instead, change the tag to `edge` — that is an explicit choice,
so that "just run the compose file" stays a predictable instruction.

### Configuration

Every environment variable, its type, its default and what it does is in
[`docs/server-env.md`](docs/server-env.md). That file is generated from the
server's own schema and checked against it by a test, so it cannot drift; this
README deliberately does not repeat the table, because a fourth copy of a list is
a fourth thing to keep in step.

Two variables in `compose.yaml` are read by the container's entrypoint rather
than by the server, and both are only useful if you are shipping your own Android
build:

| Variable | What it is |
|---|---|
| `TAPKART_ANDROID_PACKAGE` | your APK's `applicationId` |
| `TAPKART_SHA256_FINGERPRINTS` | the SHA-256 fingerprint(s) of the certificate that signed it, comma separated |

With **neither** set, the server starts normally and writes no
`assetlinks.json`. That is the correct configuration if you are not shipping an
APK, and it is tested.

### You do not need to rebuild anything to change your domain

The running web app builds every invite URL and QR payload from
`location.origin`, at run time. Serve it wherever you like and it is correct by
construction.

**Only someone shipping their own APK needs a domain-specific build.** An Android
intent filter is compiled into the APK and can never be runtime-configurable, so
that one build takes a `TAPKART_ORIGIN` — and it is a *build* variable, never a
container one. There is no `TAPKART_ORIGIN` in `compose.yaml` and there should
not be.

### Check the well-known path yourself

The container is tested; your tunnel and your reverse proxy are not.

```bash
curl -I https://tapkart.example/.well-known/assetlinks.json
```

Expect `200` and `content-type: application/json`, and **no redirect at all** —
not even to the same URL with a trailing slash. Android's App Links verifier does
not follow redirects for this file, and a failed verification is silent on
Android 12 and newer: the tap simply opens a browser instead of the app.

### A third-party endpoint, disclosed

`ICE_SERVERS` defaults to `stun:stun.l.google.com:19302`, a **third-party STUN
endpoint contacted at connection time** by every player's browser. It is a
default rather than an empty value because with no STUN server WebRTC succeeds
only on the same LAN, so essentially every real guest falls back to relaying
through your server and the peer-to-peer architecture stops existing. If you
would rather not use it, set `ICE_SERVERS` to your own — see
[`docs/server-env.md`](docs/server-env.md).

## Before you trust the tap

CI proves the bytes the tap exchanges, in both languages, against one shared
fixture. It cannot prove the tap works: that needs two physical phones in antenna
contact. [`docs/owner-verification.md`](docs/owner-verification.md) is the
fifteen-item on-device checklist, including the four ways App Links can fail with
no error message anywhere.
````

- [ ] **Step 2: Run the structural checks**

These are commands, not tests, and each one checks a fact rather than a phrasing.

Run: `grep -c '^[0-9]\+\.' docs/owner-verification.md`
Expected: **15**. §14.1 fixes the list *"so a task cannot quietly shorten it"*, and this is the cheapest way to notice if it was.

Run: `grep -n 'PORT\|MAX_ROOMS\|ICE_SERVERS' README.md | grep '|'`
Expected: exactly one line — the `ICE_SERVERS` mention in the disclosure paragraph is prose, and the only table in the README is the two entrypoint variables. If a row like `| PORT | 3031 |` appears, §11.4's *"the README grows no fourth copy of the table"* has been violated and the drift test cannot see it.

Run: `grep -c 'docs/server-env.md' README.md`
Expected: **3 or more** — the configuration section, the STUN paragraph, and wherever else it is natural. §18.3 takes Plan 4's stated assumption: the README links, and grows no table.

Run: `test -f docs/server-env.md && echo present || echo 'MISSING — Plan 4 ships it'`
Expected: `present`. Every link above is dead until Plan 4 has merged; if it is missing, that is Plan 4's deliverable and not a reason to inline the table here.

Run: `grep -rn 'tapkart.example' README.md docs/owner-verification.md | wc -l`
Expected: a non-zero count, and **every** hostname in both files is that one. Then the mechanical check that owns the general case:

Run: `npx vitest run packages/invite/test/no-secrets.test.ts`
Expected: **3 passed.** These are the two files in the repository most likely to acquire a real domain out of habit, and this is the test that would catch it.

Run: `grep -n 'Signing the Android app' README.md | wc -l`
Expected: **2** — the heading Task 12 wrote, and the one link to it from this task's item 15 reference. Any more and the section has been written twice.

- [ ] **Step 3: The verification that actually matters**

Work through `docs/owner-verification.md` on real hardware, and **record the result of every one of the fifteen items** — including the two that are supposed to fail (9 and 10) and the two that may be "not available" (7 and 11).

A checklist nobody has walked is a checklist that is wrong, and the specific way this one goes wrong is that items 4 to 8 all *look* like they pass when App Links has silently failed: the guest still reaches the lobby, in a browser, and the race still works. **Watch for whether a browser opened**, not for whether the guest joined.

- [ ] **Step 4: Commit**

```bash
git add docs/owner-verification.md README.md && git commit -m "docs: the fifteen-item owner checklist, and the self-host section (§11.7, §14)"
```
