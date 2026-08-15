# Plans 4 and 5 — Controller Rulings

**Status:** binding. Both contracts are rewritten to match every ruling below before any task is authored. Where a ruling contradicts a draft, the ruling wins; where a ruling contradicts the spec, say so and stop.

**Input:** `2026-08-14-plan45-question-triage.md` — 97 open questions triaged into 5 gaps, 7 cross-plan conflicts, 23 forks, 53 pre-ruled, 13 invalidated. The 53 pre-ruled stand as written. The 13 invalidated are moot. This document rules the 23 forks and the 7 conflicts; the 5 gaps are ruled in the Plan 2 ledger (P2-R18 through P2-R22) and in P3-R49.

---

## Cross-plan conflicts

These are the dangerous ones: each draft is internally consistent and neither can see that it disagrees with the other.

### C-1. The invite path is `/r/`. One constant, in `@tapkart/protocol`.

Plan 5 wrote `/j/`, Plan 4 wrote `/r/`. **`/r/` wins** — the URL is a room's address, not an action, and it names the resource the way the rest of the routing does.

This matters more than a naming argument: **the prefix is compiled into the APK's `autoVerify` intent-filter `pathPrefix` and is frozen at the first signed release.** A mismatch is spec §2's silent App Links failure — the tap opens a browser instead of the app, with no error anywhere.

So it is **one exported constant**, and `lobbyPathFor`, `resolveRoute`, the invite-URI builder, the QR payload, the web manifest and the intent-filter template all read it. Not two constants that agree today.

### C-2. Plan 5 generates `assetlinks.json`; Plan 4 serves it.

Clean split along the existing package boundary. Plan 5's `write-assetlinks.ts` produces the file from `TAPKART_SHA256_FINGERPRINTS` at container start; Plan 4's static handler serves `/.well-known/assetlinks.json` **with no redirect**, which spec §2 and §9 both demand and which is Plan 4's business because it owns routing.

Plan 4's static handler must therefore treat `/.well-known/*` as a real route with no trailing-slash normalisation and no HSTS-driven redirect, and assert that in a test. Plan 5 asserts the *content* is well-formed and the fingerprint parses.

### C-3. The web client reads `location.origin`. `TAPKART_ORIGIN` exists only where a build-time constant is unavoidable.

The drafts disagreed because they each solved half of it. The resolution is that these are genuinely two different needs:

- **Invite URIs, QR payloads, anything the running web app builds** → `location.origin`, at runtime. A self-hoster on any domain then works with **no rebuild**, and the origin is correct by construction.
- **The Android intent filter and `assetlinks.json`** → `TAPKART_ORIGIN`, at build time, because an intent filter is compiled into the APK and can never be runtime-configurable.

This makes F-P5-11's honest consequence much narrower than the draft feared: **only someone shipping their own APK needs a domain-specific build.** A self-hoster serving the PWA rebuilds nothing.

### C-4. Plan 4 owns the Playwright harness.

Each draft assigned it to the other. Spec §8's E2E row is *"Playwright drives two browser contexts joining by code and finishing a race"* — which needs the server, the lobby and the room code. All three are Plan 4's. Plan 4 creates `playwright.config.ts` and the lane; Plan 5 adds specs to it.

### C-5. The server is an esbuild bundle. (Also settles F-P4-6.)

Three options were live: `tsx`/`--experimental-strip-types` in the image, `tsc` emit for `server`, or an esbuild bundle.

**esbuild bundle, one file.** It is the fastest start, it is already the tool Plan 3's content gate uses, and it keeps the repo's "every `exports` points at `.ts`" arrangement intact everywhere else. Decisively: shipping an **experimental Node flag as the production entry point** is a liability with no upside, and `tsc` emit means maintaining a second module-resolution story for one package.

Plan 4 owns the bundle script; Plan 5's Dockerfile consumes its output.

### C-6. One env schema module in `server`, and the compose file is asserted against it.

The container's environment did not match the server's parser, in two drafts written a day apart. That is not a naming slip, it is a missing single source of truth.

`server/src/env.ts` declares every variable, its type, its default and whether it is required. The Dockerfile, the compose file and the README table are **checked against it by a test** that fails when they drift. A variable that exists in one and not the other is a build failure, not a 3 a.m. discovery.

### C-7. `ROOM_CODE_ALPHABET` lives in `@tapkart/protocol`.

It had three homes. A room code travels on the wire in `hello`, so `protocol` is where it belongs, and `game`, `server` and `invite` may all depend on `protocol`.

---

## Plan 4 forks

### F-P4-7. Move the tick accumulator into `@tapkart/net`. One definition.

`server/ticker.advanceTicker` and `game/clock.advanceAccumulator` are the same function with the same `MAX_CATCHUP_TICKS`, duplicated because `server` may not import `game`.

Two copies of a catch-up constant **will** drift, and spec §11 names catch-up as a top risk — so this is the constant least able to afford two homes. It moves to `net`, which both already depend on. Plan 3's contract is locked but has not executed; this is a one-line import change there, recorded as an amendment.

### F-P4-11. Add `clientUpdate: 0x05` and `resyncRequest: 0x14`.

Overloading `hello` for ready toggles, character changes, track choice, start, resync requests and seat reclaims means every handler distinguishes intent by **field inspection** — and Plan 4's own §15 already ranks the `MessageKind`→handler table as a top-4 shared-name risk. Field-inspection dispatch is how that risk becomes a defect.

`WIRE_TAG` is a map with unused space, not a frozen artifact. Adding tags is additive: no existing message's bit layout changes.

### F-P4-15. 12 characters / 60 bits, and the token is the **reconnect** credential only.

Confirmed against ruling P2-R16: per-message identity comes from the **transport peer**, via the server's authorised `peerId → playerId` map. The session token proves *"I am the player who held seat N"* across a reconnect, when the peer identity is necessarily new. It is stored in `localStorage`, never in the URL, and never used as a per-message credential.

That division is what makes P2-R16's identity-by-claim acceptable in Plan 2's loopback scope and authenticated here.

### F-P4-16. Ship a public STUN default, overridable, documented.

An empty default means WebRTC succeeds only on the same LAN, so **essentially every real guest falls to the WebSocket relay and the server carries the whole race** — which discards the entire peer-to-peer architecture and multiplies server cost by the number of guests. That is not a conservative default, it is a different product.

Default `stun:stun.l.google.com:19302`, overridable via the env schema (C-6), and **documented in the README as a third-party endpoint contacted at connection time**, so a self-hoster who objects can change one variable. Disclosure is the answer to the privacy cost, not crippling the transport.

### F-P4-22. The shadow owns host-loss detection — but it counts milliseconds, not its own ticks. Delete the server's second detector.

GAP-4 found two detectors: `ShadowLoop`'s internal tick counter (shipped and tested) and Plan 4's wall-clock `maybePromote`. One must own it.

**The shadow owns it**, because the promote path it guards is already written, tested and mutation-checked. But the draft's objection to it is correct: a tick counter stalls exactly when `stepRace` runs zero ticks or clamps at `MAX_CATCHUP_TICKS`, which is spec §11's second risk — so the shadow **under-counts** and promotes late in precisely the conditions that cause host loss.

So the counter becomes **elapsed milliseconds, passed in from the scheduler**, matching how `net` already takes time as a parameter everywhere. One detector, wall-clock-based, in the loop with the tested promotion. Plan 4's `maybePromote`/`liveness.hostLost`/`noteHostSnapshot` are removed.

**A clean socket close does not promote immediately.** Mobile browsers close sockets on backgrounding routinely, and 1.5 s is already the spec's answer. A clean close *does* immediately mark that player's kart bot-driven — which is a separate concern from authority, and the two must not be conflated.

### F-P4-23. Authority never returns to the original host. (Confirms P2-R19.)

A returning host rejoins as an ordinary client. This needs the demotion mechanism GAP-3 found missing, which is scheduled as Plan 2 Task 15c: `AuthorityLoop` handles an `authorityChange` it did not send by demoting — stop broadcasting snapshots and events, stop emitting.

Chosen over "return on reconnect" because it makes the policy question **moot rather than answered**: there is exactly one authority at every instant, and no rewind rule is ever needed.

### F-P4-24. The race keeps playing when the server dies. Surface it; do not reconnect in v1.

Tearing down a working WebRTC race because the *backup* authority died is the worst of the three options. The race continues host-authoritative, relay-attached guests drop (they have no path), and the UI shows that the backup authority is gone.

Background reconnection is the better behaviour and is deliberately **not** in v1 — Plan 4 is already the largest plan in the project, and this is a graceful-degradation improvement on a path that already degrades gracefully.

### F-P4-27. Late-join checkpoints come from the shadow.

In-process, no round trip through a phone's uplink at the worst possible moment. The joiner starts up to one snapshot interval behind and reconciles forward — which is exactly what reconciliation is for, and the shadow is by construction within reconciliation bounds of the host.

### F-P4-31. The server owns lobby truth.

Server-authoritative for seats, names, ready flags, track and start.

The apparent tension with "host-authoritative" is not real: **that phrase is about the race simulation, not the lobby.** They are different concerns and conflating them is what makes the host-owns-it option tempting. Concretely, host-owned lobby truth fails at exactly the moment this entire plan exists to survive — the host backgrounding a browser tab.

### F-P4-34. Five-character room codes **and** per-code failed-join limiting.

This project has already been bitten by precisely this: behind a Cloudflare Tunnel every request is one TCP peer, and IP-keyed limiting once collapsed to 60 accounts per building per 15 minutes.

So: **do not key on `CF-Connecting-IP`** — trusting a header is correct only while the deployment is behind the thing that sets it, and self-hosters will not be.

- **Five characters** — 32⁵ ≈ 33.5 M, still typeable, 32× the space of four.
- **Limit failed joins per room code**, not per IP. It needs no client identity, it cannot be defeated by the tunnel, and it directly bounds the only attack.

With ten-minute rooms, even sustained guessing is far below one hit per day, and a guessed room's worst outcome is a stranger in a kart race.

### F-P4-39. `RTC_CONNECT_TIMEOUT_MS = 4000`. After two failures a room goes relay-first, with a background upgrade.

8 s of black screen before fallback is too long — 4 s is past the point where a working connection would have formed and short enough not to read as broken.

After two consecutive guests fail to reach this host, further guests **attach over the relay immediately and attempt WebRTC in the background**, upgrading if it succeeds. Joins stay fast for everyone behind a symmetric NAT, and a transient failure does not condemn the room to relaying for its whole life. The transport swap this needs already exists for promotion, so it is reuse rather than new machinery.

### F-P4-44. The host→server snapshot feed is a latest-wins mailbox of depth 1.

Neither drafted option is right. "Droppable under back-pressure" advances the host-loss timer toward promoting a shadow whose host is perfectly healthy; "never dropped" lets a bad server link head-of-line-block the host's own reliable channel and back-pressure into the game loop.

**Never queue; always replace.** The host's newest snapshot overwrites any unsent one. The host never blocks, the shadow always gets the freshest state the socket can carry, and **starvation then means the socket is genuinely stalled — which is host loss, correctly detected.** The failure mode the drafts were trading off against each other stops existing.

### F-P4-46. Yes — exactly one test may bind `127.0.0.1:0`.

Without it, `runtime/http.ts` + `runtime/ws.ts` — the composition root — is the one thing CI never executes. Untested composition roots are where this project has repeatedly found its gaps: the host had no input path at all, and nobody noticed for a whole plan.

An ephemeral loopback bind is hermetic and leaves the machine untouched. The rule is restated as **"no *external* network in tests"**, the test is named in the contract, and it is the only one permitted to do this.

---

## Plan 5 forks

### F-P5-2. Hand-write the QR encoder.

Byte mode, ECC-M, Reed–Solomon over GF(256), masking, format info. Several hundred lines — and every one of them pure, fully testable, and implementing an **ISO spec that has not changed since 2006 and will not.** A dependency here buys nothing and costs supply-chain surface in a repo whose entire runtime dependency list is `three` and `ws`.

**Test against published reference vectors**, never against the encoder's own output. A QR encoder that round-trips with itself and produces a code no phone can read is exactly this project's signature defect in a new costume.

### F-P5-10. The APK bundles the web build.

Follows from F-P5-26: offline is a requirement, and a WebView pointed at a remote origin is useless without network — the opposite of what a PWA is for. `cap sync` copies `apps/web/dist`.

### F-P5-11. `TAPKART_ORIGIN` is build-time, and C-3 makes that cost small.

Confirmed: the intent filter is compiled into the APK and can never be runtime-configurable, so a runtime origin would make the two halves disagree — which is the silent App Links failure again.

But per C-3, only the APK and `assetlinks.json` use it. **A self-hoster who serves the PWA and ships no APK rebuilds nothing.**

### F-P5-16. Add the `ACTION_NDEF_DISCOVERED` filter.

Four lines that catch the app-installed case on Android 15 and earlier — spec §2's argument is specifically about Android 16+ behaviour, so leaving it out silently degrades every older device.

The "two code paths" objection does not survive inspection: both filters deliver the **same URI to the same handler.** It is one path with two entry points, and a test asserts both intents resolve identically.

### F-P5-26. Offline solo is a requirement, and it gates the build.

It is what makes this a PWA rather than a website, and the game is *fully playable* solo against bots with zero server involvement — the offline story here is unusually complete, so shipping it as "nice-to-have" would waste something already true.

Gated ⇒ the service worker's precache list is load-bearing and a broken offline path fails CI instead of shipping silently.

### F-P5-28. `ONE_SHOT_SPECS` is authored by the task with reasoned defaults, then tuned by the owner on a device.

**Not delegated.** The track palettes were a good delegation because the gate could check them — ranges, schema, uniqueness, real parsers. Sound-design numbers have no schema-level notion of correct: a model's output cannot be gated meaningfully, so delegation would produce confident garbage with a green check beside it.

Downstream of P3-R49: until two `RaceView`s exist, none of these sounds can play at all.

### F-P5-31. Pin by rule, not by guess — and record the values.

Neither draft could verify these and neither should invent them. The binding constraints:

- **`targetSdk` ≥ the Android 16 API level.** Spec §2's entire argument is about Android 16 behaviour; a lower target opts out of it.
- **`compileSdk` = `targetSdk`.**
- **`minSdk` = max(the pinned Capacitor major's floor, 26).** HCE needs API 19, so Capacitor's floor is what actually binds; 26 is the sensible modern floor and picking it too low silently ships to devices nothing was tested on.
- **Capacitor major pinned in `package.json`**, per spec §9, with AGP, Gradle and the Kotlin plugin taken from that version's template **unmodified**.

The implementing task **reads the template's actual values and writes them into the contract**, rather than any of us asserting numbers we have not checked. That is the honest form of this pin.

### F-P5-33. `latest` moves on `v*` tags only. `master` publishes `edge`.

The README's compose file must mean *a release*, not whatever merged five minutes ago — anything else makes "just run the compose file" an unpredictable instruction. Self-hosters who want head get `edge`, explicitly.

### F-P5-45. Clear the NFC advert on pause.

Spec §2 already says a sleeping screen stops HCE, so leaving the advert set buys only the narrow backgrounded-but-awake window — in exchange for a failure that is **mysterious rather than predictable**. A tap that fails the same way every time is debuggable by the owner and explainable to a guest; one that works only while the screen happens to be on is neither.

Update §11's owner-verification step to match: tapping a backgrounded host is expected to fail.

---

## Amendments this creates in already-locked work

| Ruling | Lands in | Change |
|---|---|---|
| F-P4-7 | Plan 3 contract §5.1 | `advanceAccumulator` imported from `@tapkart/net`, not defined in `game` |
| F-P4-11 | `@tapkart/protocol` | `WIRE_TAG` gains `clientUpdate: 0x05`, `resyncRequest: 0x14` |
| F-P4-23 | Plan 2 Task 15c | `AuthorityLoop` demotes on a foreign `authorityChange` (P2-R19) |
| F-P4-22 | Plan 2 Task 15c | `ShadowLoop`'s host-loss counter takes elapsed ms, not ticks |
| C-1, C-7 | `@tapkart/protocol` | `ROOM_CODE_ALPHABET` and the `/r/` path prefix live here |
| F-P4-34 | `@tapkart/protocol` | Room codes are **five** characters |

---

## Late rulings, from locking the Plan 5 contract

### L1 — spec §2 amended rather than overridden. Room codes are five characters, and the spec now says so.

Plan 5's contract flagged that F-P4-34 contradicts spec §2's "four-character room code". It was right
to flag it: **the spec is the binding authority, so a ruling that disagrees with it is a defect until
the spec changes.** Spec §2, §5 and the lifecycle section now read five, with the reasoning recorded —
the Cloudflare Tunnel making every request one TCP peer, this project's own prior collapse to sixty
accounts per building per fifteen minutes, and the fact that the length is frozen into the APK's
`pathPrefix` and the emulated NDEF bytes at the first signed release.

### L2 — `chooseOrigin`, and `TAPKART_ORIGIN` stops being a container variable.

Plan 5 found that applying C-3 literally — "the running web app uses `location.origin`" — emits
`https://localhost/r/ABCDE` inside a Capacitor WebView. That is the silent failure C-3 exists to
prevent, occurring **on the only device that has HCE at all**.

Resolved with a pure `chooseOrigin(isNative, buildOrigin, locationOrigin)`: browser takes
`location.origin`, native takes `TAPKART_ORIGIN`, and it throws if native with no build origin rather
than emitting a URL nobody can join. The consequence is clean — `TAPKART_ORIGIN` is a **build**
variable only, so it leaves the compose file entirely.

### L3 (a NEW cross-plan defect, found only once both contracts existed) — the compose file would stop the server booting.

Plan 4's `parseConfig` **throws on any unknown `TAPKART_*` variable**, and Plan 5's compose file must
set two of them for the assetlinks generator. As the two contracts stood, **the compose file that C-6
exists to keep in step with the server is the one thing that prevents the server from starting.**

Neither contract could see this alone; it is the third defect of that shape this project has produced,
after the invite-path split and the origin question. Confirmed fix: `ENV_SCHEMA` gains both variables
with `required: false`, which preserves C-6's single source of truth, and CI starts the container
**with** them — so the failure lands in a build rather than in the owner's deploy.

### L4 — the README links to `docs/server-env.md`. No fourth copy of the env table.

Three copies checked against one schema (C-6) is already the maximum a test can keep honest.
