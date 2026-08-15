# Plan 4 + Plan 5 — Triage of the 97 Open Questions

**Status:** triage only. §3's forks need the controller. §4's rulings are binding
unless the controller overrules them. §1 and §2 are findings, not questions, and
should be read first.

**Sources read:** Plan 4 draft §16 (50 questions), Plan 5 draft §17 (47), the spec
(§2, §3, §5, §7, §8, §9, §11), the Plan 3 **rulings** doc (Q1–Q34), the **ruled**
Plan 3 contract (R35–R47, which supersedes the rulings doc in several places), and
the shipped Plan 2 code in `.claude/worktrees/plan2-net/packages/`.

| Bucket | Count |
|---|---|
| Gaps in already-written / already-ruled work | 5 |
| Cross-plan conflicts (7 distinct, covering 8 questions) | 7 |
| Forks — need the controller | 23 |
| Pre-ruled (mechanical) | 53 |
| Invalidated by an existing ruling or by shipped code | 13 |

Each cross-plan conflict is also a fork; they are listed once, in §2, and are not
repeated in §3. Plan 4's Q1, Q21 and Q25 are already ruled and are not re-raised.

---

## 1. GAPS — code that cannot work as written

### GAP-1. Audio one-shots can never fire. The entire cue system is dead in the shipped shell.

`buildAudioModel` derives every one-shot from the delta between two views
(ruled Plan 3 contract §4.9, line 1660):

```ts
export function buildAudioModel(prev: RaceView, view: RaceView, out: AudioModel): void
```

But Plan 3 allocates exactly one `RaceView` per session — §4.2, line 1213:

> `/** Allocates one fully-populated RaceView with every array at its fixed length
>  *  and every Vec3 distinct. Called once per session, never per frame. */`
> `export function createRaceView(itemBoxCount: number): RaceView`

`ViewBuilder.build(alpha, out)` is the **"SOLE WRITER of every RaceView field.
Allocates nothing"** (§5.11), and `startShell`'s frame loop (§5.13) runs
`viewBuilder.build(alpha) → buildRenderFrame → … → buildAudioModel → audio.apply`
with one `build` per frame. There is no second view and no swap anywhere in the
contract, so `prev` is either the same object as `view` (every delta empty) or
does not exist. **No `impact`, `itemUse`, `itemPickup`, `boost`, `spinOut`,
`lapCross`, `countdownBeep` or `finish` cue can ever fire in the shipped game.**

Why it stays green: §8.1's assertion — *"a lap crossing between two views fires
exactly one `lapCross` cue"* — hand-builds two views with the test-only
`makeRaceView` (§9.1). The unit test passes; the shell cannot reproduce its
precondition.

Fix belongs in Plan 3 (§4.2/§5.13), not Plan 5: two `RaceView`s allocated at
session construction, alternated per frame, with the swap **after** `audio.apply`
(Plan 5 §2.1's own rule that cues are consumed the same frame). Plan 5's entire
§8 Web Audio backend and its Q28 `ONE_SHOT_SPECS` table are downstream of this.

### GAP-2. One malformed datagram throws out of a transport callback and kills the room — or the server process.

`decodeHeader` throws on an unknown tag, a version mismatch, **or a short buffer**
(`buf[0]` on an empty array is `undefined`, which misses `TAG_TO_KIND`) —
`packages/protocol/src/types.ts:43-55`. All three shipped loops call it directly
inside their `Transport.onMessage` callback:

- `packages/net/src/authority.ts:115` — `const header = decodeHeader(data)`, no length guard.
- `packages/net/src/client.ts` (onMessage), whose own comment at `client.ts:313`
  states the behaviour as intended: *"an unknown TAG still throws in decodeHeader above"*.
- `packages/net/src/shadow.ts` (onMessage) — guards `data.length === 0` only.

Under `LoopbackTransport` both ends always speak `PROTOCOL_VERSION` 1, so this
never fired. Over Plan 4's real `WebSocketTransport` / `WebRtcTransport` the bytes
arrive from a public socket: on the server the throw propagates out of `ws`'s
`'message'` handler → uncaught exception → **the process exits, killing every
room**, reachable by any guest with one byte. Plan 4 §1 states the hard rule
(*"A malformed frame closes one socket; it never takes the process down"*) but
§2a's list of files Plan 4 modifies does not include a non-throwing wrapper for
the three loops, and §9.1 asserts non-throwing only for `net/wsframe` and
`net/signal`.

The *expected* trigger is not an attacker: it is a version mismatch after a
deploy, which Plan 5 Q25 guarantees (never auto-`skipWaiting`, so old clients keep
running old bundles).

Same family, same fix needed: `decodeCheckpoint` **throws** when
`dst.itemBoxes.length` disagrees (`protocol/src/checkpoint.ts:171-175`), inside
`ClientLoop.onMessage` — Plan 4 Q27 names this as a crash and then leaves it as a
confirm.

### GAP-3. There is no demotion path. A returning host is a second authority.

`ShadowLoop.promote()` broadcasts `authorityChange`, flips `ctx.isLeader`, and
begins broadcasting snapshots at 20 Hz and events (`shadow.ts:309-311, 319-357`).
`AuthorityLoop` handles **only** `kind === 'input'` on `'unreliable'`
(`authority.ts:115-121`) and has no `demote`, no `stop`, and no handler for
`authorityChange` — grep for "demote" in `authority.ts` returns nothing.

So a host that was merely unreachable for 1.5 s (backgrounded tab, tunnel hiccup,
or Plan 4 Q22's proposed instant promote-on-clean-close) resumes broadcasting
authoritative snapshots and events on the same channels as the promoted shadow,
with its own `nextEventSeq`. Every client that still holds the WebRTC channel then
reconciles alternately against two divergent authorities. Plan 4 Q23 asks the
*policy* question ("can authority return to the host?"); no mechanism exists to
stop the old one under **either** answer, and §2a does not budget the change.

### GAP-4. Plan 4 is written against `packages/net/src/shadow.ts` "which does not exist". It exists, and it already does three of the things Plan 4 assigns to the server.

Plan 4 §3.2: *"**`packages/net/src/shadow.ts` does not exist in the worktree.**
`packages/net/src/` holds `apply.ts`, `authority.ts`, `client.ts`, `index.ts`,
`loopback.ts`, `transport.ts` and nothing else"*. It shipped at commit `40ba73b`
("feat(net): add ShadowLoop, the server's per-room shadow authority") and is
re-exported from `packages/net/src/index.ts`. It answers Q20 (promote broadcasts
`authorityChange` itself; flips its own `ctx.isLeader`; broadcasts snapshots at
`tick % 3` and events after promotion), Q29 (`reconcile` is **private**, called
from `tick()`), and Q21 (`promotionCursor(raceSeed, tick)` — `raceSeed` is never
written, so `statesEqual` stays usable).

**The live defect:** `ShadowLoop.tick()` already self-promotes —

```
shadow.ts:316   if (this.ticksSinceSnapshot >= HOST_TIMEOUT_TICKS) this.promote(this.live.tick)
```

— counting *shadow ticks* since the last snapshot **received on its own
transport** (`HOST_TIMEOUT_TICKS = 90`). Plan 4 §6.9/§7.1 adds a *second*
detector, `maybePromote` + `liveness.hostLost` + `noteHostSnapshot`, counting
*wall-clock milliseconds* in `RoomHub.poll`. `promote()` is idempotent so nothing
double-fires, but the two timers disagree exactly under load — the shadow's timer
stalls whenever `stepRace` runs zero ticks or clamps at `MAX_CATCHUP_TICKS`, which
is precisely spec §11's second risk. §3's fork F-P4-22 asks which one owns it.
Plan 4 §3.2, §6.9, §7.1, §7.2 and §16 Q20/Q29 all need rewriting from the source.

### GAP-5. `apps/web/tsconfig.json` as ruled cannot typecheck the service worker Plan 5 must add.

Ruled Plan 3 §10.1 gives `apps/web` `"lib": ["ES2022", "DOM", "DOM.Iterable"]`
with `"include": ["src/**/*.ts", "vite.config.ts"]`. Plan 5 §13 creates
`apps/web/src/sw.ts`, and its Q41 proposes a single
`/// <reference lib="webworker" />` inside that program. TypeScript's `dom` and
`webworker` libs cannot coexist in one compilation — `self`, `fetch`,
`AbortController`, `EventTarget` and dozens more are declared in both. `npm run
typecheck` fails the moment `sw.ts` lands. Ruled mechanically in §4 (P5 Q41).

---

## 2. CROSS-PLAN CONFLICTS — neither draft can see these

### C-1. The invite path. `/j/` vs `/r/`. (Plan 5 Q13, Plan 4 Q35's neighbourhood)

Plan 5 §4 (`packages/invite/src/invite.ts`):

> `export const INVITE_PATH_PREFIX = '/j/'`
> `/** buildInviteUri('https://tapkart.example', 'ABCD') -> 'https://tapkart.example/j/ABCD'. */`

Plan 4 §6.11 (`server/src/static.ts`):

> `export const LOBBY_PATH_PREFIX = '/r/'`
> `/** '/r/ABCD'. A PATH, never an absolute URL … */`
> `export function lobbyPathFor(code: string): string`

and its §9.1 test row: `resolveRoute('GET', '/r/ABCD')` is `spa`. Plan 5 Q13 asks
whether `/j/` collides with `/join`, `/api/*` or `/signal` — routes Plan 4 does
not have; the actual collision is with `/r/`. **This prefix is compiled into the
APK's `autoVerify` intent filter `pathPrefix` and is frozen at the first signed
release**, and a mismatch is spec §2's silent App Links failure. One prefix wins;
`lobbyPathFor`, `resolveRoute`, `INVITE_PATH_PREFIX`, the manifest and the QR
payload all take it from one constant.

### C-2. Who writes `assetlinks.json`, and into which directory. (Plan 4 Q8, Plan 5 Q37/Q38)

Plan 4 §6.2/§6.11: `wellKnownDir` — *"RELATIVE, default `'public/.well-known'`"*;
the server *"serves whatever is in `wellKnownDir` and returns 404 when absent"*.

Plan 5 §9.3: `docker/entrypoint.sh` runs `write-assetlinks.mjs`, which
*"writes `<staticRoot>/.well-known/assetlinks.json`"* — and Plan 4's `staticRoot`
defaults to `apps/web/dist`, a different directory.

As specified, the container generates the file the server never serves, and the
server 404s the path. Both halves individually pass their own tests. Ruling needs
to name one directory (and whether the generator writes into `WELL_KNOWN_DIR` or
the static root, and whether the container smoke test asserts the served bytes).

### C-3. Where the client gets the origin. `location.origin` vs `TAPKART_ORIGIN`. (Plan 4 Q35, Plan 5 Q5/Q11)

Plan 4 §1 and Q35:

> "No absolute URL containing a host is constructed anywhere in `src`. The server
> answers with **paths**; the client builds the absolute URL from its own
> `location.origin`."

Plan 5 §7.5 (`apps/web/src/platform/env.ts`):

> `/** TAPKART_ORIGIN always. Exists so no call site is tempted to reach for`
> ` *  `location.origin`, which is right in the browser and wrong in the APK. */`
> `export function appOrigin(): string`

Both cannot hold, and the disagreement bites on exactly one device: the **host**,
which is the APK — the only device with HCE. Inside the Capacitor WebView
`location.origin` is not the deployed origin, so Plan 4's rule produces an invite
URI that cannot resolve. Plan 5 is right on the mechanism; Plan 4 is right that no
host may be *compiled into a repo file* (spec §9), and `VITE_TAPKART_ORIGIN`
supplied at build time satisfies both. Rule it once, for both plans.

### C-4. The Playwright harness. Each draft assigns it to the other. (Plan 4 Q9, Plan 5 Q8)

Plan 4 §14: *"**No Playwright E2E**, unless §16 Q9 rules otherwise."*
Plan 5 §10.3: *"The E2E harness itself is Plan 4's (Plan 3 §8.3 assigns it there,
since it needs a server to join). Plan 5 adds specs to it."* — while Plan 5 §10.1
already ships a CI `e2e` job that runs the harness nobody has agreed to build.

Ruled Plan 3 §8.3 does assign it to Plan 4, and Plan 4's counter-argument
("everything must be testable with no browser") is about its **vitest** suite, not
about a separate lane. Whoever owns it, `playwright.config.ts`, the two-context
join spec and the CI job must land in one plan.

### C-5. How the server is built and started. (Plan 4 Q6, Plan 5 Q7)

Plan 4 §12: `"start": "node --experimental-strip-types src/main.ts"`, and then:
*"The `start` script's `--experimental-strip-types` is a placeholder … §16 Q6 asks
how the server is actually launched in the shipped image."*

Plan 5 §9.1's Dockerfile build stage: *"`npm ci` at the root (workspaces),
`npm run build -w apps/web`, **the Plan 4 server build**, and `npx esbuild …`"* —
naming a build command that does not exist, and Plan 5 §13 adds a root `build`
script without saying what it runs.

Three of Plan 5 Q7's four sub-questions are answerable from Plan 4's draft today
(`@tapkart/server`; static root via `STATIC_ROOT`, default `apps/web/dist`; health
at `/healthz`; `PORT` default 3031). Only the build command is open, and it
decides whether this repo acquires its first emit step.

### C-6. The container's environment does not match the server's parser. (Plan 5 Q39, Plan 4 §6.2)

Plan 5 §9.2 ships four variables: `PORT`, `TAPKART_ORIGIN`,
`TAPKART_ANDROID_PACKAGE`, `TAPKART_SHA256_FINGERPRINTS`.

Plan 4 §6.2 recognises: `PORT`, `BIND_HOST`, `STATIC_ROOT`, `TRACKS_DIR`,
`WELL_KNOWN_DIR`, `MAX_ROOMS`, `ROOM_IDLE_MS`, `JOIN_RATE_WINDOW_MS`,
`JOIN_RATE_MAX`, `ICE_SERVERS`, `SHADOW_ENABLED` — and *"Throws with the offending
variable's NAME in the message; a server that starts with a silently-defaulted
misspelled variable is worse than one that refuses."*

Three of Plan 5's four are unknown to Plan 4, and Plan 5's compose sets no
`STATIC_ROOT` or `WELL_KNOWN_DIR` even though the runtime image lays files out
under `/app/…` while both defaults are relative to the checkout. The compose file
as drafted either starts a server serving nothing, or refuses to start. One
variable list, owned by one plan, referenced by the other.

### C-7. `ROOM_CODE_ALPHABET` now has three homes. (Plan 4 Q14, Plan 5 §4)

Ruled Plan 3 §5.8 puts `ROOM_CODE_LENGTH`, `ROOM_CODE_ALPHABET`,
`normalizeRoomCode`, `isValidRoomCode` in `packages/game/src/roomcode.ts`.
Plan 4 Q14 moves them to `@tapkart/protocol` and deletes the `game` copy, because
`server` cannot import `game`. Plan 5's `packages/invite` is declared **"Zero
dependencies"** and yet `buildInviteUri` *"[throws] on a room code that
`isValidRoomCode` would reject"* and `parseInviteUri` rejects *"any malformed room
code"* — a third implementation — while R39 makes `game` depend on `invite`, so
`invite` can never import `game`.

One ruling must cover all three. `protocol` is importable by `server`, `net`,
`game` and `invite` alike and is the only node in the graph all four can reach.

---

## 3. FORKS — the controller's calls (23)

### Plan 4

**F-P4-6 (Q6) — how the server is launched; whether Plan 4 introduces the repo's first build step.**
Every package's `exports` points at `.ts` and there is no emit anywhere.
(a) `tsx`/`--experimental-strip-types` in the image — no build, but ships an
experimental flag as the production entry. (b) `tsc` emit for `server` only —
a real build step, one package. (c) esbuild bundle — one file, fastest start,
and the tool Plan 3's Q2 gate already uses. See also C-5.

**F-P4-7 (Q7) — one accumulator or two.**
`server/ticker.advanceTicker` duplicates Plan 3's `game/clock.advanceAccumulator`,
same shape and same `MAX_CATCHUP_TICKS`, because `server` may not import `game`.
(a) Two copies — no amendment, but the catch-up constant now has two homes and can
drift. (b) Move it into `@tapkart/net` and have Plan 3 import it — one definition,
one amendment to a ruled contract.

**F-P4-11 (Q11) — `hello` as the universal client→server message, or two new tags.**
Ready toggles, character changes, track choice, start, resync requests and seat
reclaims are all one idempotent declaration today.
(a) One `hello` — no twelfth `WIRE_TAG`, `WIRE_TAG` stays frozen; every handler
must distinguish intents by field inspection. (b) Add `clientUpdate: 0x05` and
`resyncRequest: 0x14` — semantically clean, costs a protocol amendment.
Plan 4 §15 ranks the `MessageKind`→handler table as a top-4 shared-name risk.

**F-P4-15 (Q15) — session tokens: length, and whether the token is the only proof of seat ownership.**
12 characters of the 32-symbol alphabet = 60 bits, stored in `localStorage`, never
in the URL. *Check against the existing Q25 ruling first:* if that ruling gave the
server an authorised `peerId → playerId` map, the token's role is already fixed and
this collapses to confirming the length.

**F-P4-16 (Q16) — the shipped STUN default.**
(a) Empty — no external dependency, no privacy disclosure, and WebRTC then
succeeds only on the same LAN, so essentially every real guest falls to the
WebSocket relay and the server carries the whole race. (b) A named public STUN
endpoint — direct connections work, at the cost of a third-party dependency the
repo ships to every user.

**F-P4-22 (Q22) — who owns host-loss detection, and may a clean socket close promote immediately.**
Per GAP-4 there are now two detectors: `ShadowLoop`'s internal tick counter and
Plan 4's wall-clock `maybePromote`. One must own it — the shadow's is already
shipped and tested; the server's survives a stalled ticker.
Second half: a host whose WebSocket closes cleanly is known-gone instantly;
waiting the full 1.5 s is 1.5 s with nobody driving, but promoting on a clean close
turns a tab-switch into an authority change.

**F-P4-23 (Q23) — can authority ever return to the original host.**
(a) Never; a returning host rejoins as an ordinary client — needs the demotion
mechanism GAP-3 says does not exist. (b) Return on reconnect — needs a second
`authorityChange` direction and a rewind rule. Either answer requires new code in
`AuthorityLoop`; only the amount differs.

**F-P4-24 (Q24) — what a client does when the *server* dies mid-race.**
Nothing in the spec covers it. (a) Tear the race down — loud and simple; kills a
race that was working over WebRTC. (b) Keep playing with no shadow — the race
survives, relay guests drop, and there is no promotion left if the host also
leaves. (c) Reconnect in the background — best behaviour, most code.

**F-P4-27 (Q27) — late-join checkpoints from the shadow or from the host.**
Shadow: in-process, no round trip to a phone, and the joiner starts up to one
snapshot interval behind and reconciles forward. Host: exact, and costs a
round trip through the host's uplink at the worst moment. (The crash-on-mismatch
half of this question is GAP-2, not a fork.)

**F-P4-31 (Q31) — who owns lobby truth.**
(a) Server-authoritative for seats, names, ready flags, track and start — survives
the host backgrounding a browser tab, which is the failure this whole plan exists
for. (b) Host owns it and the server relays — matches "host-authoritative" more
literally and keeps one authority concept in the system.

**F-P4-34 (Q34) — room-code brute force behind a single-IP tunnel.**
32⁴ ≈ 1.05 M codes, ten-minute rooms, and spec §9's Cloudflare Tunnel makes every
request one TCP peer — this project has already been bitten by exactly that.
(a) Key on `CF-Connecting-IP` (trusting a header). (b) Limit failed joins per room
code. (c) Five-character codes (33.5 M, still typeable). (d) Accept it — a joined
stranger can only race.

**F-P4-39 (Q39) — the relay-only decision.**
`RTC_CONNECT_TIMEOUT_MS = 8000` is invented; 8 s of a black screen before a guest
falls back is a product call. Second half, and the real fork: should a guest skip
WebRTC entirely once two prior guests failed to reach this host — faster joins for
everyone behind a symmetric NAT, at the cost of permanently relaying a room that
might have worked.

**F-P4-44 (Q44) — droppable snapshot feed to the shadow.**
The host's snapshots reach the server over TCP, so a stalled socket
head-of-line-blocks the host's own reliable channel and back-pressures into the
game loop. (a) Droppable under back-pressure — protects the host, and drops
advance the host-loss timer toward promoting a shadow whose host is perfectly
healthy. (b) Never dropped — the shadow is always truthful, and a bad server link
can stall the host's race.

**F-P4-46 (Q46) — may one smoke test bind `127.0.0.1:0`.**
Without it, `runtime/http.ts` + `runtime/ws.ts` — the composition root — is the one
thing CI never executes. With it, "no network in tests" stops being absolute.
An ephemeral loopback bind is hermetic and leaves the machine untouched.

### Plan 5

**F-P5-2 (Q2b) — hand-written QR encoder or a pinned dependency.**
Byte mode, ECC-M: Reed–Solomon over GF(256), masking, format info — several
hundred lines of well-specified, highly testable code, no dependency, in a repo
whose total runtime dependency list is `three` (+ `ws`). Against: it is the one
piece of Plan 5 that is pure reimplementation of a solved problem.

**F-P5-10 (Q10) — does the APK bundle the web build, or point a WebView at the deployed origin.**
Bundle: offline works (Q26), `cap sync` copies `apps/web/dist`, and the app can
ship stale. `server.url`: always current and `location.origin` is correct for
free — and the app is useless with no network, which is the opposite of a PWA.
Interacts with C-3 and F-P5-11.

**F-P5-11 (Q11) — `TAPKART_ORIGIN` build-time or runtime.**
The Android intent filter is compiled into the APK and can never be
runtime-configurable, so a runtime origin makes the two halves disagree. The
draft's position — "one build per domain is the honest consequence of App Links" —
means a self-hoster on another domain rebuilds both artifacts. The alternative
buys container portability and gives up App Links for anyone but the owner.

**F-P5-16 (Q16) — also register an `ACTION_NDEF_DISCOVERED` filter.**
Four lines that catch the app-installed case on Android 15 and earlier (spec §2's
argument is about Android 16+). Against: two routes into the app, two code paths
to debug, and the one that fires depends on the guest's OS version.

**F-P5-26 (Q26) — is offline solo a requirement or a nice-to-have.**
Requirement ⇒ Plan 5 §10.3's spec 26 gates the build and the service worker's
precache list becomes load-bearing. Nice-to-have ⇒ the same spec is informational
and a broken offline path ships silently.

**F-P5-28 (Q28) — who tunes `ONE_SHOT_SPECS`.**
It is the entire sound design of the game, as data, with not one number filled in.
(a) DeepSeek under spec §10, gated like the track palettes. (b) Authored blind by
the task and tuned by the owner on a device. Note this sits downstream of GAP-1:
until two `RaceView`s exist, none of these sounds can ever play.

**F-P5-31 (Q31) — the version pins.**
Capacitor major (spec §9 requires it pinned), AGP, Gradle, Kotlin plugin,
`compileSdk`, `minSdk`, `targetSdk`. The draft declines to invent them and says
only that `targetSdk` must be ≥ the Android 16 API level. `minSdk` is the one with
teeth: HCE needs API 19, the pinned Capacitor will demand higher, and picking it
wrong silently excludes devices.

**F-P5-33 (Q33 + Q34a) — the release trigger, and whether `latest` moves on every commit.**
(a) `latest` on `v*` tags only — the compose file in the README then means a
release, not a commit. (b) `latest` also on master — self-hosters track head and
every merge is a deploy. This is a different deploy story, not a tag-naming
detail.

**F-P5-45 (Q45) — keep advertising while the host app is backgrounded.**
Leave the advert set: a host who switches apps stays tappable, but
`FLAG_KEEP_SCREEN_ON` no longer applies and the screen sleeps, which spec §2 says
stops HCE anyway. Clear it on pause: the tap fails predictably instead of
mysteriously. Either answer changes §11's owner-verification step.

---

## 4. PRE-RULED (MECHANICAL) — 53

### Packaging and dependencies (P4 Q3, Q4, Q5; P5 Q12, Q30, Q41, Q42, Q43)

**P4 Q3 — `packages/server`.** CONFIRMED. Root `workspaces: ["packages/*"]` and the
vitest `include` already match it; the ruled Plan 3 contract §1 lists it in the
package dependency table. Spec §3's tree is a sketch, not a path spec.

**P4 Q4 — `ws`, with `@types/ws`.** CONFIRMED. Node has no built-in WebSocket
*server* and hand-rolling RFC 6455 to keep the dependency count at zero is the
least defensible line in the project. Use `@types/ws`, not a hand-written ambient
declaration — a local re-declaration of a third-party surface is a silent drift
source, and Plan 5 §0's "one task pins every version" convention covers the pin.

**P4 Q5 — local minimal DOM declarations in the two `-browser.ts` adapters.**
CONFIRMED, and already binding: ruled Plan 3 §10.1 (R35) — *"`packages/sim`,
`packages/protocol`, `packages/net` and `packages/content` keep `lib: ["ES2022"]` —
no DOM, ever. Those four are the packages `server` imports."* A per-package `lib`
override on `net` is forbidden by that line.

**P5 Q12 — `applicationId = io.github.atvriders.tapkart`.** CONFIRMED. The org is
public in the spec's first line; the alternatives claim domains we do not own.

**P5 Q30 — `esbuild` as a declared root devDependency.** CONFIRMED. Plan 3's Q2 gate
already invokes it; declaring a binary you execute is correct, and relying on a
transitive Vite dependency is how a major bump breaks the deploy.

**P5 Q41 — see GAP-5.** The DOM half is already ruled (R35 / Plan 3 §10.1 widens
`render`, `game`, `apps/web`). The WebWorker half: `sw.ts` gets its **own**
`apps/web/tsconfig.sw.json` with `"lib": ["ES2022", "WebWorker"]` and is
`exclude`d from `apps/web/tsconfig.json`; the `typecheck` script runs both. A
`/// <reference lib="webworker" />` inside the DOM program is a duplicate-identifier
error, not an idiom.

**P5 Q42 — the no-secrets grep test stays in vitest.** It then runs on every
developer's machine before the push, not only after it.

**P5 Q43 — `tapkart.example`.** CONFIRMED. RFC 2606 reserved; it can never resolve.

### Protocol and wire format (P4 Q10, Q12, Q13, Q18, Q19, Q30, Q38, Q41, Q42, Q45)

**P4 Q10 — cold path returns, hot path fills `out`.** CONFIRMED. The split is by
allocation cost, and three of the new messages carry strings and allocate anyway.
Forcing `out` on them buys a worse signature and no saved allocation.

**P4 Q12 — signalling is JSON over WebSocket text frames.** CONFIRMED. SDP is opaque
text; a bit-packed codec for it saves nothing and adds a parser. §9.1 already
tests `parseSignal` against 20 hostile inputs.

**P4 Q13 — `trackId` travels as a string.** CONFIRMED. ~20 B against a manifest index
that breaks silently the day the six tracks are reordered in one place and not the
other.

**P4 Q18 — names: 16 UTF-8 bytes, no filter, no uniqueness, empty is legal.**
CONFIRMED, and the UI shows "Player *n*" for an empty name. This is a friends-only
room reached by a four-character code; a moderation system for it is scope Plan 1
of 5 did not buy.

**P4 Q19 — `ping`/`pong` on the unreliable channel.** CONFIRMED. A heartbeat behind
retransmits measures the retransmit queue, not liveness. Safe against GAP-2's
dispatch: `AuthorityLoop` filters on `header.kind` (`authority.ts:115-116`), not on
channel alone.

**P4 Q30 — `authorityChange {tick, eventSeq}` is frozen at two fields for v1.**
CONFIRMED, and already frozen in shipped code:
`encodeAuthorityChange(out, tick, eventSeq)` / `AUTHORITY_CHANGE_BYTES = 10`
(`shadow.ts`). The only promotee is a server every client already holds a socket to.

**P4 Q38 — the three-byte WS envelope.** CONFIRMED. ~150 B/s per peer against a
second source of truth for a channel mapping four components must agree on
(Plan 4 §15 ranks it the #1 shared-name risk — which is an argument for having one
authoritative copy of it, not for deriving it twice).

**P4 Q41 — `partId + '/' + peerId`, `/` forbidden in both halves.** CONFIRMED. Naming
with no downstream consequence; readable room logs are worth the assertion.

**P4 Q42 — the guest is the offerer and creates both DataChannels.** CONFIRMED. One
convention had to be picked, the answerer's `onDataChannel` path is entirely
different, and every task touching WebRTC must assume the same one.

**P4 Q45 — MTU.** CONFIRMED: 743 B + 2 + 3 = 748 B worst-case unreliable datagram, no
fragmentation layer anywhere, checkpoints ride the reliable channel which fragments
for us. Arithmetic, not a decision.

### Rooms, lobby and session (P4 Q26, Q28, Q32, Q33, Q36, Q37, Q43; P5 Q5, Q14, Q46)

**P4 Q26 — `beginRace` is additive; the constructor is unchanged.** A ruled contract
stays ruled and Plan 3's `createSession` keeps compiling. `beginRace` leaves
`phase === 'countdown'`, which is correct for a real race; Plan 2's integration
test calls `beginRace` on both sides (or keeps its own harness), because a test
fixture must not fix the shipped default.

**P4 Q28 — `HARD_RESYNC_LIMIT = 3` in `HARD_RESYNC_WINDOW_TICKS = 600`.** CONFIRMED as
starting values, and the client is the right detector: it is the only participant
that knows, and a client that lies only costs itself a checkpoint that the server's
rate limiter already bounds.

**P4 Q32 — `humanMask` as drafted.** CONFIRMED. `createState` makes every seat
`isBot: true, connected: false` (`state.ts:59-83`), so the mask is the only thing
that can say otherwise, and "in the room but not ready" is still a human seat. A
post-`start` joiner takes a bot's seat via late join and the authority flips
`isBot`, which reaches everyone through the snapshot's two independent bits.

**P4 Q33 — `roomIdleMs = 600_000`, `maxRooms = 64`, `maxPeersPerRoom = 8`; refuse at
the cap.** CONFIRMED as starting points (spec §11 says measure early, and F-P4-49
below makes that measurable). Refusing with `roomFull` beats evicting a live race.

**P4 Q36 — post-results reset as drafted.** CONFIRMED: phase → `'lobby'`,
`RaceRuntime` disposed, seats and `characterIdx` survive, `raceSeed` re-minted at
the next `start`, `lobbyVersion` bumps. Bot-filled seats stay bot-filled until a
human claims one — the room's seat map is the room's, not the race's.

**P4 Q37 — the ninth joiner is refused with `roomFull`; no spectators, no queue.**
CONFIRMED. Spec §1 caps the grid at 8 and Plan 4 §14 already says so.

**P4 Q43 — back-pressure.** CONFIRMED: unreliable datagrams dropped past 1 MiB
`bufferedAmount` and counted; reliable never dropped, and a socket whose reliable
buffer exceeds a hard cap is **closed**. Unbounded memory growth on a shared server
process is worse than one peer reconnecting.

**P5 Q5 — `inviteUri` is derived, not stored.** CONFIRMED:
`buildInviteUri(appOrigin(), state.roomCode)`, where `roomCode` is already
authoritative in `AppState` (ruled Plan 3 §5.9) and the origin comes from C-3's
ruling. Contingent on C-1 and C-3 only.

**P5 Q14 — the invite URI carries the room code and nothing else.** Every extra
parameter is another `pathPrefix` mismatch, another `parseInviteUri` rejection path,
and another thing to keep in sync with a compiled-in intent filter.

**P5 Q46 — a guest who taps into an expired room.** The machinery already exists:
Plan 4's `handleHello` returns `roomNotFound`, and ruled Plan 3 §5.9's `AppState`
has `error: string` and `connecting: boolean`. Ruling: land on `title` with
`error` set to a room-expired message and the typed code preserved so the player
can retry or type another. No new screen (Plan 3 Q14).

### NFC, APDU and Android (P5 Q9, Q15, Q17, Q18, Q19, Q20, Q21, Q22, Q23, Q44)

**P5 Q9 — flatten `apps/android` if the pinned Capacitor honours `android.path`.**
Verify at pin time (F-P5-31) and fall back to the nested layout, shifting every
path in §6.1/§10.2 by one directory. A verify-then-branch, not a judgment.

**P5 Q15 — `requireDeviceUnlock="true"`.** CONFIRMED, because spec §2 already states
it as a known limit (*"The host's screen must be on and unlocked for HCE to
respond"*) and the spec is the binding authority. Changing it is a spec amendment,
not a manifest attribute.

**P5 Q17 — `setPreferredService` while the lobby is open.** CONFIRMED. It is the only
defence against another installed app claiming the same AID, and it costs an
activity reference the lobby already has.

**P5 Q18 — CC values: MLe `0x00F6`, MLc `0x00FF`, max NDEF file `0x0400`, write
denied.** CONFIRMED. Standard Type 4 Tag values, pinned into a fixture two
languages replay; write access denied is correct for a tag that only ever serves.

**P5 Q19 — over-read truncates and returns `90 00`.** CONFIRMED. Android's reader
never over-reads; `6C XX` would be correctness theatre for readers we do not target.

**P5 Q20 — the §5.4 status-word table, and TSV rather than JSON.** CONFIRMED. TSV
keeps Gson/kotlinx-serialization off the Android unit-test classpath, where
`org.json` is stubbed — a real constraint, not a preference.

**P5 Q21 — the non-advertising state serves an empty NDEF file (`00 00`).**
CONFIRMED. A readable empty tag is a defined state; refusing SELECT is an error a
guest's phone reports as a broken tag.

**P5 Q22 — no Android Application Record.** CONFIRMED. An AAR sends an app-less guest
to a Play Store page for an app that is not on the Play Store, breaking exactly the
row of spec §2's table that must work.

**P5 Q23 — reader mode on only while a tap-actionable screen is foregrounded, off in
`handleOnPause`.** CONFIRMED. Always-on intercepts every transit card and hotel key
the phone touches while the app is open.

**P5 Q44 — nothing is built for iOS.** CONFIRMED. Spec §1 puts the iOS app out of
scope and §2's iPhone row is pure OS behaviour over a standards-compliant Type 4
tag; there is nothing to write and nothing to assert.

### PWA and audio (P5 Q25, Q27, Q47)

**P5 Q25 — never auto-`skipWaiting`; the update lands after results or on the next
cold load.** CONFIRMED. Swapping the bundle under a running authority loop is not a
trade worth making. (This is what makes GAP-2's version-mismatch throw a *routine*
event, not an exotic one.)

**P5 Q27 — icons generated at build time into a gitignored directory.** CONFIRMED.
Three binaries in a public repo with no test that they match the manifest is the
worse half; a deterministic encoder is assertable.

**P5 Q47 — `SwRequestInfo` is a plain struct, not a `Request`.** CONFIRMED, and
required by Plan 3 ruling Q30 (`node` everywhere, no jsdom, no per-file override).
Typing against `Request` would pull DOM types into a pure module and make the seam
meaningless.

### CI, deploy and secrets (P5 Q32, Q34, Q35, Q36, Q37, Q38, Q40)

**P5 Q32 — Node 20 in CI, JDK 21 for Android, `npm ci` at the root first.**
CONFIRMED. Spec §9 fixes JDK 21, root `engines` fixes Node ≥20, and `cap sync`
cannot run without `apps/web/dist`.

**P5 Q34 — image tags and the container job.** Every push that publishes tags the
**version and the commit SHA**; whether `latest` moves is F-P5-33. The `container`
job is **gating**, not informational — it is the only thing that proves the served
`assetlinks.json` exists with the right content type and no redirect, which is
spec §2's silent-failure mode.

**P5 Q35 — `TAPKART_SHA256_FINGERPRINTS` as a repo *variable*.** CONFIRMED. A signing
certificate fingerprint is published to the world in `assetlinks.json` by design;
§1 forbids it in a repo *file*, and a variable is not a file. CI may echo it into a
generated `assetlinks.json` inside a container it then curls.

**P5 Q36 — yes, a second slot for the local debug fingerprint.** Spec §2 explicitly
permits it (*"so a locally-built debug APK also verifies during development"*), and
it can only ever be set by the owner, locally.

**P5 Q37 — `writeAssetLinks`: unset → skip, log one line, exit 0; set but malformed →
exit 1.** CONFIRMED. A self-hoster with no APK gets a working server; a
misconfigured fingerprint fails loudly instead of serving a valid-looking statement
that signs nothing.

**P5 Q38 — ship the documented `curl -I` no-redirect check.** CONFIRMED, as step 1's
companion in `docs/owner-verification.md`. The container test proves the container;
the tunnel, the proxy and any trailing-slash normalisation are outside that proof
and inside the owner's.

**P5 Q40 — `docs/owner-verification.md` and the README keystore section are Plan 5
deliverables.** CONFIRMED; spec §11 makes the README half mandatory
(*"Backed up on creation; documented in the repo README"*).

### Testing (P4 Q40, Q47, Q48, Q49, Q50)

**P4 Q40 — `Transport.onMessage` appends, and the conformance suite is worth it.**
CONFIRMED. `loopback.ts:75-77` already appends, a guest runs `ClientLoop` and
`RoomClient` on one transport, and a replace-semantics implementation deletes the
lobby silently. Promote all six behaviours in Plan 4 §3.1 into the `Transport`
contract and assert them against all four implementations.

**P4 Q47 — the promotion test lives in both places.** CONFIRMED split: the
`ShadowLoop`-level test is `net`'s (Plan 2 already ships `net/test/shadow.test.ts`)
and the end-to-end kill-the-host test is `server`'s, because only the hub owns the
transports. Spec §8's row is satisfied by the pair.

**P4 Q48 — no `node:wrtc`-class integration test.** The fake `RtcConnectionLike` pair
proves the state machine; SCTP ordering, partial reliability and ICE restarts are
owner-verified on two phones, exactly as Plan 4 §9.3 already states.

**P4 Q49 — a benchmark script the owner runs, not a test CI runs.** A wall-clock
assertion over N rooms on shared CI is a flake generator. Spec §11 asks for a
measurement, not a gate.

**P4 Q50 — ship the import-allowlist test.** Ten lines that read every
`src/**/*.ts` and check import specifiers against an allowlist make spec §3's
dependency direction mechanically checkable repo-wide — including the rule that
`server` never reaches `three`, `game` or `render`, which is otherwise enforced by
discipline alone. Same class as Plan 5 §1's no-secrets grep.

---

## 5. INVALIDATED — already answered (13)

| Question | Answered by |
|---|---|
| **P4 Q1** — where `Tuning`/`CharacterStats` live | Already ruled: `packages/content` (R46, ruled Plan 3 contract §3a). Not re-raised. |
| **P4 Q2** — does the server read `content/tracks/*.json` from disk | R46. `@tapkart/content` §3a.5 exports parsed tracks via **static JSON imports specifically so a non-Vite Node/tsx/esbuild toolchain can consume them** (§3a.1), and §1 lists `@tapkart/content` in `server`'s dependencies. `server/content.ts`'s `TRACKS_DIR`, `loadTracks`, `listDir`/`readFile` injection all disappear; `contextFor` stays. This also deletes the two-mechanisms drift the question worried about. |
| **P4 Q17** — `normalizeRoomCode` drops rather than substitutes | Ruled Plan 3 §5.8: *"Upper-cases, strips every character outside the alphabet, truncates to `ROOM_CODE_LENGTH`. Total: never throws."* Substitution is impossible anyway — neither `0` nor `1` is in the alphabet. |
| **P4 Q20** — `ShadowLoop.promote` semantics | Shipped code, see GAP-4: it broadcasts `authorityChange`, flips its own `ctx.isLeader`, and broadcasts at 20 Hz after promotion. The residue is F-P4-22 (who detects). |
| **P4 Q21** — the PRNG re-seed formula | Already ruled (P2-R14) and shipped: `this.live.rngCursor = promotionCursor(this.live.raceSeed, tick)` — `raceSeed` is never written, so `statesEqual` between authority and shadow stays meaningful, which is what the question was protecting. |
| **P4 Q25** — reclaim and seat ownership | Already ruled. Not re-raised. |
| **P4 Q29** — does `ShadowLoop` expose `reconcile` | Shipped: `private reconcile(snap: WireSnapshot)`, called from `tick()`. |
| **P5 Q1** — `@tapkart/invite` or `@tapkart/nfc` | R39 already names it: *"`@tapkart/game` may take a dependency on **`@tapkart/invite`**"*. |
| **P5 Q3** — may Plan 5 write into `packages/render` | R39: *"Plan 5 may add files under `packages/render/src/audio/` … and may add the barrel lines that export them."* Use that directory rather than the draft's `src/audio-graph.ts` + `src/web/audio.ts`. |
| **P5 Q4** — `nfc` on `ShellOptions`, and `game` → `invite` | R39 permits both explicitly, so no task stalls asking. Plan 5 §13's two "conditional" rows are unconditional. |
| **P5 Q6** — `apps/*` in `workspaces`, `apps/*/test` in vitest | R36 and R37: Plan 3 makes both edits. Plan 5 §13's first two rows disappear (and `apps/web` already exists — Plan 3 Q11). |
| **P5 Q24** — portrait support | R40, which names this exact manifest line: *"landscape only … Plan 5's PWA manifest `"orientation": "landscape"` is a consequence of this line, not an independent decision."* The shell shows a rotate-your-device overlay. |
| **P5 Q29** — widening `WebAudioBackend` with `setConfig` | R38 already put `setConfig(cfg: AudioConfig)` and `AudioConfig { masterGain, enabled }` **in the `AudioBackend` seam**, plus `nullAudioBackend`. No widened concrete type, no Plan 3 amendment. Note Plan 5 §2.1/§2.2 quote the pre-ruling **draft** (two-method backend, `audio: AudioBackend \| null`) — both are stale against the ruled contract. |
