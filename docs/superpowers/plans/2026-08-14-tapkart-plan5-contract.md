# Tapkart Plan 5 — Locked Interface Contract

> **STATUS: LOCKED.** This is binding. It is the **Global Constraints** section of
> the Plan 5 implementation plan: every task's requirements implicitly include
> everything here. No task may rename, re-sign, or add fields to anything below.
> A task needing something absent must define it in its own files and say so in
> its `Interfaces` block — and if two tasks would need the same absent thing,
> that is an amendment, not a local definition.
>
> The draft this replaces carried 47 open questions. They are triaged in
> `2026-08-14-plan45-question-triage.md` and ruled in
> `2026-08-14-tapkart-plan45-rulings.md`. Every ruling is applied below and the
> open-questions section is **gone**. §17 records where each ruling landed. §18 is
> the short list of things genuinely still open, and it contains no confirmations.

**Spec:** `docs/superpowers/specs/2026-08-13-tapkart-design.md` (amended 2026-08-14). The spec is the binding authority; where this contract and the spec disagree, the spec wins and this contract is wrong. **One exception is recorded in §18.2**, where a ruling knowingly overrides a spec sentence.
**Rulings:** `2026-08-14-tapkart-plan45-rulings.md` (Plans 4+5) and `2026-08-14-tapkart-plan3-rulings.md` (Plan 3). Binding over any draft, always.
**Binding spec sections for this plan:** §2 in full (including *Known limits*), §7 (Content — audio), §8's *What CI cannot verify*, §9 (Build and deploy), §11 (Risks).
**Builds on:** Plan 1 (`@tapkart/sim`, merged `1f1f2c4`), Plan 2 (`@tapkart/protocol` + `@tapkart/net`), Plan 3 (`@tapkart/content`, `@tapkart/render`, `@tapkart/game`, `apps/web` shell — contract **locked**, 23 tasks authored), Plan 4 (`packages/server` — contract in authoring against the same rulings).
**Scope:** `packages/invite`, `apps/android`, the PWA and Web Audio halves of `apps/web`, the Web Audio implementation behind Plan 3's `AudioBackend` seam, and all CI/CD and deploy. **Plan 5 of 5.**

> **Android toolchain correction (verified 2026-08-15, supersedes later
> generation/CI literals):** the selected Capacitor 8 line requires Node 22 or
> newer, so the root engine and every workflow use Node 22+. Generate into a
> temporary nested/staging Android path first, move the complete template into
> the contract's flat `apps/android/` layout, set `android.path` to `.` only
> after that move, and run `cap sync android` again so path-sensitive generated
> files are rebuilt. Preserve the template's Cordova include, Google Services
> classpath/conditional, coordinator-layout, splash-screen and Android test
> dependencies during Kotlin-DSL conversion. `printTapkartPins` uses ordinary
> Kotlin interpolation, `config.xml` is force-added despite the template ignore,
> and `.kotlin/` is ignored. A clean-checkout Android CI job must build the web
> app and run `cap sync android` before Gradle because the generated Cordova
> module is intentionally ignored.

Every Plan 3 signature quoted in §2 is quoted from the **locked** contract
(`2026-08-14-tapkart-plan3-contract.md`) or from Plan 3's authored task files,
not from the pre-ruling draft. Where the Plan 5 draft quoted the draft of Plan 3
and got it wrong, the correction is called out inline in those words.

---

## 0. Conventions that are decided, not negotiable

Plans 1–3's conventions carry forward unchanged and are **not** restated except
where Plan 5 adds to them. In particular: extensionless imports; `import type`
under `verbatimModuleSyntax`; bare specifiers across packages in `src`, never a
relative path into another package; vitest with `globals: false` and
`environment: 'node'` — **no jsdom and no per-file `@vitest-environment`
override, in any file Plan 5 writes** (Plan 3 ruling Q30); TypeScript 5.9
`strict` with `noUnusedLocals`, `noUnusedParameters`.

New for Plan 5:

| Convention | Value |
|---|---|
| Byte containers | `Uint8Array` everywhere in TS, `ByteArray` everywhere in Kotlin. Never `Buffer`, never `number[]`, never a hex string, in any signature |
| Hex in fixtures and logs | **uppercase, unseparated**, e.g. `00A4040007D276000085010100`. One spelling, so a string compare is a byte compare |
| APDU byte order | ISO 7816 is **big-endian** (offsets, file IDs, NLEN). This is the opposite of Plan 2's wire rule, and the opposition is load-bearing: `protocol` is little-endian because we chose it, `invite` is big-endian because ISO 7816-4 and the NFC Forum Type 4 Tag operation say so |
| NDEF byte order | big-endian (`NLEN`, payload lengths) |
| `packages/invite` touches no clock, no DOM, no network, no global | It is a pure codec package whose **only** dependency is `@tapkart/protocol` (§4.0). `NfcHost` is an *interface* it declares, never an implementation it holds |
| Placeholders | See §1. **No real domain, LAN IP, hostname, host filesystem path, keystore, key, fingerprint or token appears in any file this plan writes.** No exceptions, no "just for the example" |
| Secrets reach the build as CI secrets/variables | never as repo files. A repo file may name the variable; it may never carry the value |
| Adapters contain no decisions | Plan 3 §0a's rule, extended to Kotlin and to the service worker. A conditional in an adapter is a contract violation, because it is a decision CI cannot see |
| Version pins | Every third-party version (Capacitor, AGP, Gradle, Kotlin plugin, `esbuild`, every GitHub Action) is pinned **once**, by the version-pin task that fills in §6.6's table, and every other task reads the pinned value. No task bumps a version to make its own step pass |
| Invented numbers | Forbidden where a published table or a template already carries the number. §6.6 (Android/Capacitor) and §5.9 (QR) both work this way: the contract fixes the **rule and the format**, the implementing task **reads and records the value** |

### 0a. The three-kind rule, extended to a second language

Plan 3 §0a says every `render`/`game` module is **pure** or **adapter** and the
file says which in its first line. Plan 5 has the same rule and one more kind,
because it is the first plan with non-TypeScript source and with files that are
neither:

- **Pure** — a function of its arguments. No DOM, no `AudioContext`, no
  `android.*` import, no clock, no I/O. **Tested, and tested in both languages
  where both implement it.** Everything in `packages/invite`,
  `render/src/audio/graph.ts`, `apps/web/src/pwa/*`, and the Kotlin `nfc/Hex.kt`,
  `nfc/NdefUri.kt`, `nfc/T4tTag.kt`, `nfc/InviteIntent.kt`.
- **Adapter** — the thin layer handing plain data to a real device API. No
  branching on game state, no arithmetic beyond unit conversion.
  `apps/web/src/sw.ts`, `apps/web/src/platform/*`, `render/src/audio/web.ts`,
  and the Kotlin `TapkartHceService`, `TapkartNfcPlugin`, `InviteReader`,
  `LobbyAdvert`, `MainActivity`.
- **Declaration** — XML, Gradle, Dockerfile, compose, workflow YAML. Not
  executable by vitest at all. These are checked by **structural assertions over
  the file itself** (§12.2) or by running the artifact they produce, never by
  being trusted.

The whole design of this plan is the fight to move as much as possible from the
third kind into the first. `processApdu` is the prize: the NFC tap cannot run in
CI, but the bytes the tap exchanges are a pure function over byte arrays, and
those *can* be proven — in both languages, against one shared fixture (§5).

---

## 1. The placeholder rule, stated once with the exact values

Spec §9: *"No real LAN IPs, hostnames, or host paths appear in the repo.
Placeholders and RFC 5737 ranges only; the owner substitutes locally."* This repo
is public. Plan 5 is the only plan that would otherwise touch a real domain, a
real certificate and a real key, so the rule is made concrete here.

| Thing | The **only** value that may appear in a repo file |
|---|---|
| Deployed origin | `https://tapkart.example` (RFC 2606 reserved TLD) |
| Deployed host | `tapkart.example` |
| A second example origin | `https://kart.example.com` |
| IPv4 examples | `192.0.2.10`, `198.51.100.7`, `203.0.113.4` (RFC 5737) |
| Loopback in a healthcheck or a test bind | `127.0.0.1` — permitted; it is not a host detail |
| Android `applicationId` | `io.github.atvriders.tapkart` (P5 Q12) |
| SHA-256 cert fingerprint | `DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF` — 32 obviously-fake bytes, format-valid so validators can be tested against it |
| Keystore | **never in the repo, in any form, at any size.** Not the file, not base64 of it, not its passwords, not its real fingerprint |
| SDK / JDK locations | never written down. CI gets them from the setup actions; local dev gets them from the environment |
| Room code in examples | `ABCDE` — **five** characters (F-P4-34). Every `ABCD` in the Plan 5 draft is stale |
| Invite path in examples | `/r/` (C-1). Every `/j/` in the Plan 5 draft is stale |

Two mechanical guards, both cheap, both required:

1. A repo-wide test (`packages/invite/test/no-secrets.test.ts`, P5 Q42 — in
   **vitest**, so it runs before the push and not only after it) enumerates the
   tracked files with `git ls-files` and greps each for: a `-----BEGIN` block, a
   `.jks`/`.keystore`/`.p12` path, an **RFC1918 address** — a complete dotted
   quad inside `10.0.0.0/8`, `172.16.0.0/12` or `192.168.0.0/16`, never a bare
   prefix, so that a document *describing* the rule does not trip it — and any
   32-byte colon-hex string that is **not** the `DE:AD:BE:EF…` placeholder. It fails on a hit. **If `git ls-files` cannot be
   run it fails the test** — a repo-reading test that silently passes when it
   cannot read the repo is this project's signature defect wearing a hat.
2. `.gitignore` carries `*.jks`, `*.keystore`, `*.p12`, `keystore.properties`,
   `local.properties`, `apps/android/local.properties`,
   `apps/android/app/src/main/assets/public/`, `apps/android/app/build/`,
   `apps/android/.gradle/`, `apps/web/dist/`, `apps/web/.vite/`,
   `apps/web/public/icons/`, `packages/server/dist/`.

`local.properties` matters more than it looks: Gradle writes the SDK path into it
automatically on first local build, and that path is a real host path.

**Exactly two tests in this repository read the repository's own files:**
`no-secrets.test.ts` above and `deploy-env.test.ts` (§11.4, C-6's drift test).
Both are named here so a third does not appear by accident.

---

## 2. What Plans 1–4 export that Plan 5 consumes

### 2.1 `@tapkart/render` — the audio seam, quoted from the **locked** contract

Plan 3 contract §4.9, verbatim
(`2026-08-14-tapkart-plan3-contract.md:1633-1684`). The Plan 5 draft quoted the
**pre-ruling draft** of this file and was wrong in two places; both corrections
are marked.

```ts
export type AudioCueKind =
  | 'engine' | 'skid' | 'impact' | 'itemPickup' | 'itemUse'
  | 'boost' | 'spinOut' | 'respawn' | 'lapCross' | 'countdownBeep' | 'finish'

export interface AudioCue {
  kind: AudioCueKind
  playerId: number
  intensity: number           // 0..1
  pan: number                 // -1 (left) .. 1 (right), from the camera's right axis
}

export interface AudioModel {
  engineFreqHz: number        // LOCAL kart only
  engineGain: number          // 0..1
  skidGain: number            // 0..1
  cues: AudioCue[]            // fixed length MAX_AUDIO_CUES; only [0, cueCount) is live
  cueCount: number
}
export const MAX_AUDIO_CUES = 16
export function createAudioModel(): AudioModel

/** Derives continuous levels from `view` and one-shots from the delta between
 *  `prev` and `view`. SOLE WRITER of every AudioModel field. Pure and
 *  assertable: a test drives two views and asserts exactly which cues fire.
 *  Cues beyond MAX_AUDIO_CUES in one frame are dropped, oldest-kind-first, never
 *  grown. */
export function buildAudioModel(prev: RaceView, view: RaceView, out: AudioModel): void

/** Device/user preference, NOT a property of the audio the race is producing.
 *  R38: volume and mute must never be fields of AudioModel — a model that
 *  carries a setting means moving a slider re-plans a frame. */
export interface AudioConfig {
  masterGain: number          // 0..1
  enabled: boolean            // false mutes without tearing the backend down
}

/** ADAPTER boundary. Plan 5 puts Web Audio behind this and touches nothing else. */
export interface AudioBackend {
  apply(model: AudioModel): void
  /** R38: the seam carries its config from day one, so a live settings change
   *  has somewhere to go and Plan 5 needs no widened concrete type and no
   *  amendment to this contract. Called on every Settings change, not per frame. */
  setConfig(cfg: AudioConfig): void
  close(): void
}

/** The v1 backend. Implements all three methods trivially. */
export const nullAudioBackend: AudioBackend
```

**Correction 1 — `AudioBackend` has three methods, not two.** R38 put
`setConfig(cfg: AudioConfig)` **in the seam**. The draft's §8.2
`WebAudioBackend = AudioBackend & { setConfig(...) }` intersection is therefore
**deleted**: there is no widened concrete type, `createWebAudioBackend` returns a
plain `AudioBackend`, and `apps/web` holds exactly the same type the game holds.

**Correction 2 — `AudioConfig` is Plan 3's and has exactly two fields.** The
draft's `AudioGraphConfig { enabled, masterGain, engineSmoothingMs,
maxOneShotsPerFrame }` is **deleted**. The two tuning numbers are module
constants of the graph (§9.2), not configuration: nothing outside `render` ever
sets them, and a config field nobody writes is a field that drifts.

Two consequences no task may relitigate:

- **`cues` is cleared on every `buildAudioModel`.** Therefore `audio.apply(model)`
  must run in the *same frame*, after `buildAudioModel` and before the next one.
  §13 makes that a sole-writer rule and §2.2 quotes the shipped frame order that
  guarantees it.
- **`AudioModel` has no master volume and no enabled flag.** `Settings` (Plan 3
  §5.7) has `audioEnabled` and `audioVolume`; the bridge is `setConfig`, called
  by the shell on every settings change and once at startup — **never per frame**.

### 2.2 `@tapkart/game` — the `RaceView` double buffer (P3-R49), quoted

This is the amendment that makes the whole of §9 possible. GAP-1 found that Plan
3 allocated **one** `RaceView` per session, so `buildAudioModel(prev, view, out)`
was always called with `prev === view`, every delta was empty, and **no
`impact`, `itemUse`, `itemPickup`, `boost`, `spinOut`, `lapCross`,
`countdownBeep` or `finish` cue could ever fire in the shipped game** — while the
unit test stayed green, because it hand-builds two views with the test-only
`makeRaceView`.

P3-R49 fixes it in Plan 3, in `packages/game/src/session.ts`. The shipped shape,
quoted from Plan 3's authored Task 20:

```ts
export interface RaceSession {
  // … role, ctx, tickOnce, state, prevState, sampleRemoteKart, … unchanged …

  /** The RaceView THIS frame is built into (§5.11's `out`).
   *
   *  There are two, because `buildAudioModel(prev, view, out)` (§4.9) derives
   *  every one-shot cue from the delta between consecutive views, and
   *  `ViewBuilder.build` is the sole writer of every RaceView field. With one
   *  view, `prev` IS `view`, every delta is empty, and no cue can ever fire in
   *  the shipped game. The session owns both because it owns the race's lifetime
   *  and knows `ctx.track.itemBoxes.length`. */
  currentView(): RaceView

  /** The RaceView the PREVIOUS frame was built into — buildAudioModel's `prev`. */
  prevView(): RaceView

  /** Exchanges the two views. The shell calls this ONCE per frame, AFTER
   *  `audio.apply` — cues are consumed in the frame they are raised, so swapping
   *  any earlier drops them. Both views are primed by `createViewBuilder`
   *  (§5.11) before the first frame, so frame 1's delta is empty rather than "a
   *  real view minus a zeroed one", which would fire a burst of spurious cues on
   *  the grid. */
  swapViews(): void

  close(): void
}
```

and the shell's frame order, quoted from Plan 3's authored Task 22 — **this is
the order Plan 5's backend is called in and Plan 5 does not change it**:

```ts
    const view = r.session.currentView()
    r.builder.build(alpha, view)
    buildRenderFrame(view, r.cam, r.theme, r.characters, r.karts, r.frame)
    renderer.applyFrame(r.frame)
    buildHudModel(view, RACE_LAPS, r.hud)
    paintHud(r.hud)
    buildAudioModel(r.session.prevView(), view, r.audioModel)
    audio.apply(r.audioModel)
    // AFTER audio.apply, never before: the cues raised by this frame's delta are
    // consumed above, and swapping any earlier drops them. Not swapping at all
    // (one shared view) makes every delta empty and no one-shot cue can fire.
    r.session.swapViews()
```

**`audio.apply` is called once per rendered frame, unconditionally, with a model
whose `cueCount` is frequently zero.** The backend must be cheap on an empty
model: no allocation, no node construction, no parameter writes that do not
change. §9.3 makes that a budget rather than an aspiration.

### 2.3 `@tapkart/game` — the shell, and the two fields Plan 5 adds

Quoted from Plan 3's authored Task 22, which is the **shipped** shape (the locked
contract §5.13 is identical):

```ts
export interface ShellOptions {
  canvas: HTMLCanvasElement
  root: HTMLElement           // where HUD/screen DOM is mounted
  clock: FrameClock
  store: KeyValueStore
  renderer: RendererBackend
  audio: AudioBackend         // nullAudioBackend in v1 (Q26)
}
export interface GameShell { stop(): void }
export function startShell(opts: ShellOptions): GameShell
```

> `ShellOptions.fetchJson` was **deleted** by Plan 3 ruling Q12 (tracks are
> statically bundled by `@tapkart/content`). It is absent above deliberately; a
> task that re-adds it is working from the pre-ruling draft. `audio` is **not**
> `AudioBackend | null` — the draft said it was; Plan 3 shipped it non-null with
> `nullAudioBackend` as the v1 value.

**Plan 5 adds exactly two fields, both optional**, which R39 licenses in those
words (*"Plan 5 may add an `nfc` field to §5.13's `ShellOptions`. Adding an
**optional** field to an options struct owned by the shell adapter is not a
re-signature of anything Plan 3 tasks share."*):

```ts
export interface ShellOptions {
  // … the six above, unchanged …

  /** The platform's invite surface: HCE advertising, reader mode, and the URI a
   *  launch intent carried. Optional so every Plan 3 call site still compiles;
   *  `startShell` substitutes `nullNfcHost` when absent, exactly as `audio`
   *  takes `nullAudioBackend`. */
  nfc?: NfcHost

  /** The origin invite URIs are built from (C-3). Optional; defaults to
   *  `location.origin`. `apps/web` computes it with `chooseOrigin` (§10.3) and
   *  passes the result in, because the APP knows whether it is running in a
   *  browser or in a WebView and the GAME must not contain that check. */
  origin?: string
}
```

`origin` is a second added field and it is not optional-by-taste: P5 Q5's ruling
is `buildInviteUri(appOrigin(), state.roomCode)` on the lobby screen, the lobby
screen is `game`'s, and `appOrigin()` is an `apps/web` adapter. Passing the
string is the only arrangement in which `game` contains no platform branch.

`packages/game` also gains a dependency on `@tapkart/invite` (R39, and P5 Q4
makes it unconditional) for `buildInviteUri`, `buildQrMatrix`, `NfcHost` and
`nullNfcHost`. `invite` depends only on `protocol`, so the graph stays acyclic
and `game` remains a leaf nothing depends on.

### 2.4 `@tapkart/protocol` — the three constants C-1, C-7 and F-P4-34 put there

**`packages/game/src/roomcode.ts` (Plan 3 §5.8) is superseded.** C-7 moves
`ROOM_CODE_LENGTH`, `ROOM_CODE_ALPHABET`, `normalizeRoomCode` and
`isValidRoomCode` into `@tapkart/protocol`, because a room code travels on the
wire in `hello` and `protocol` is the only node in the graph that `server`,
`net`, `game` and `invite` can all reach. F-P4-34 makes the length **five**. C-1
puts the invite path prefix there too.

```ts
// packages/protocol/src/roomcode.ts — Plan 4 owns this module
export const ROOM_CODE_ALPHABET: string   // 32 symbols: A–Z without I or O, 2–9
export const ROOM_CODE_LENGTH = 5         // F-P4-34: 32^5 ≈ 33.5 M, 32× the space of four
export function normalizeRoomCode(raw: string): string
export function isValidRoomCode(raw: string): boolean

// packages/protocol/src/static-ish constants — C-1: ONE constant, not two that agree today
/** The invite path prefix, '/r/'. Compiled into the APK's autoVerify
 *  intent-filter pathPrefix and FROZEN AT THE FIRST SIGNED RELEASE. Read by
 *  lobbyPathFor, resolveRoute, buildInviteUri, parseInviteUri, the QR payload,
 *  the web manifest and the intent-filter template. A mismatch is spec §2's
 *  silent App Links failure: the tap opens a browser instead of the app, with
 *  no error anywhere. */
export const LOBBY_PATH_PREFIX = '/r/'
```

**The name is `LOBBY_PATH_PREFIX`, not `INVITE_PATH_PREFIX`.** C-1 ruled the
*value* by adopting Plan 4's half of the disagreement and its reasoning (*"the
URL is a room's address, not an action"*); keeping Plan 4's spelling is the
consistent completion, and `server/src/static.ts` already names it that. The
draft's `INVITE_PATH_PREFIX` is **deleted** from `packages/invite` — it is not
re-exported, because "one exported constant" means one export site and a
re-export is a second name to grep for.

**Plan 5 never spells out the alphabet, the length or the prefix.** Everything in
`packages/invite` that needs them imports them. That is what makes C-1's freeze
mechanical instead of a convention: §12.2's manifest assertion compares the
compiled `pathPrefix` against the imported constant.

### 2.5 `packages/server` (Plan 4) — the four facts Plan 5's deploy depends on

Quoted from Plan 4's **locked** contract (`2026-08-14-tapkart-plan4-contract.md`,
§1a, §5.2, §10.3), which was ruled from the same document as this one. Plan 5's
Dockerfile, compose file and container smoke test depend on exactly four things:

1. **The server is an esbuild bundle** (C-5), built by
   `packages/server/scripts/build-server.mjs` behind the package's `build`
   script, producing exactly one ESM file at **`packages/server/dist/main.mjs`**.
   Plan 4 owns the script; Plan 5's Dockerfile runs it and copies the output. No
   `--experimental-strip-types`, no `tsx`, no second module-resolution story:
   *shipping an experimental Node flag as the production entry point is a
   liability with no upside.*
2. **One env schema module** (C-6), `packages/server/src/env.ts`, exported from
   the server's barrel as machine-readable data:

   ```ts
   export interface EnvVarSpec {
     name: string
     kind: 'number' | 'string' | 'boolean' | 'csv'
     required: boolean
     /** As a string, exactly as it would be written in a compose file. `null`
      *  when required. */
     defaultValue: string | null
     description: string
   }
   export const ENV_SCHEMA: readonly EnvVarSpec[]
   /** ENV_SCHEMA as the exact Markdown table `docs/server-env.md` contains. */
   export function formatEnvTable(): string
   ```

   Plan 4 asserts `docs/server-env.md` against `formatEnvTable()`; **Plan 5
   asserts its two container files against `ENV_SCHEMA`** (§11.4), which Plan 4
   §1a permits by name as a test-only import.
3. **The static handler serves `/.well-known/assetlinks.json` with no redirect**
   (C-2), out of **`<STATIC_ROOT>/.well-known/`** — Plan 4 deleted
   `WELL_KNOWN_DIR` so that *there is exactly one well-known directory and it is
   derived from `staticRoot`, one variable instead of two that must agree* — with
   `Content-Type: application/json`, treating `/.well-known/*` as a real route
   with no trailing-slash normalisation. Plan 5 **generates** the file (§11.3);
   Plan 4 **serves** it. Plan 5 asserts its content and the served response.
4. **`/healthz` and `PORT`** — health endpoint, `PORT` default `3031` (spec §9).

**One hazard this creates, and §12.2's assertion 30 is the test for it.**
Plan 4's `parseConfig` *"throws on an unknown variable with the prefix
`TAPKART_`, because that prefix is ours and a typo in it is always a mistake."*
Plan 5's container sets exactly two such variables — §4.7's `ASSETLINKS_ENV_VARS`
— read by the generator at container start and never by the server. **They must
therefore appear in `ENV_SCHEMA`** (as `required: false`, described as read by
the entrypoint rather than the server), or the compose file C-6 exists to keep in
step becomes the one thing that stops the server booting. §18.1 records it.

Plan 4 also owns the **Playwright harness** (C-4): `playwright.config.ts` at the
repo root with `testDir: 'e2e'`, the `e2e/` directory, the first spec
(`e2e/join-and-race.spec.ts`) and the `test:e2e` script. *Spec §8's E2E row is
"Playwright drives two browser contexts joining by code and finishing a race" —
which needs the server, the lobby and the room code. All three are Plan 4's.*
**Plan 5 adds two specs under `e2e/` and owns the CI job that runs
`npm run test:e2e`** — Plan 4 §1a assigns the job to Plan 5 by name (§12.1, §12.3).

### 2.6 `@tapkart/sim` and `@tapkart/net`

Plan 5 consumes **nothing** from these two. It ships them and it must not import
them: an NFC codec that reaches into `sim` has gone wrong somewhere upstream, and
`net` is unreachable from every package Plan 5 writes.

---

## 3. Five values that must agree, or App Links silently fails

This is Plan 5's equivalent of Plan 3 §6.3 — the failure that produces no error,
no log and no failing test, and is invisible until a guest taps a phone.

Spec §2: *"on Android 12+ a failed verification is silent — no disambiguation
chooser, the link just opens in the browser."* The guest is not blocked (QR and
room code are always shown), so **nothing about a broken App Link is loud**. It
just quietly stops being an app.

| # | Value | Lives in | Source |
|---|---|---|---|
| 1 | the **host** in the `autoVerify` `ACTION_VIEW` intent filter, and in the `ACTION_NDEF_DISCOVERED` filter beside it | `AndroidManifest.xml`, as `${tapkartHost}` | Gradle `manifestPlaceholders`, from `TAPKART_ORIGIN` |
| 2 | the **origin** the APK's WebView builds invite URIs from | the APK's web bundle, from `import.meta.env.VITE_TAPKART_ORIGIN` | the same `TAPKART_ORIGIN` |
| 3 | the **host** actually serving `/.well-known/assetlinks.json` | the deployment | the owner's tunnel, pointed at the container |
| 4 | `package_name` in `assetlinks.json` | container env `TAPKART_ANDROID_PACKAGE` | must equal Gradle `applicationId` |
| 5 | `sha256_cert_fingerprints[0]` in `assetlinks.json` | container env `TAPKART_SHA256_FINGERPRINTS` | must equal the SHA-256 of the certificate in the keystore that signed the **installed** APK |
| | the **path prefix** in 1 | `LOBBY_PATH_PREFIX` in `@tapkart/protocol` | C-1: one constant, frozen at the first signed release |

### 3.1 `TAPKART_ORIGIN` is build-time and touches exactly two artifacts (C-3, F-P5-11)

The two drafts disagreed because they each solved half of it. **These are
genuinely two different needs and the ruling gives each its own mechanism:**

- **Invite URIs, QR payloads, anything the running web app builds → `location.origin`,
  at runtime.** A self-hoster on any domain works with **no rebuild**, and the
  origin is correct by construction.
- **The Android intent filter and the APK's own web bundle → `TAPKART_ORIGIN`, at
  build time**, because an intent filter is compiled into the APK and can never
  be runtime-configurable.

**The one place the two meet, and the rule that settles it.** F-P5-10 bundles the
web build inside the APK, and inside a Capacitor WebView `location.origin` is the
WebView's local scheme — **not** the deployed origin. Applying C-3's first bullet
literally there would emit `https://localhost/r/ABCDE` into the NDEF record: a URI
no guest can open, which is the silent failure C-3 exists to prevent. So:

> **`appOrigin()` returns `location.origin` in a browser and the build-time
> `TAPKART_ORIGIN` in the native WebView.** That is not a third mechanism: per
> F-P5-11, *only someone shipping their own APK needs a domain-specific build*,
> so the APK's baked origin is by construction the same variable that produced its
> intent filter — which is precisely what keeps values 1 and 2 agreeing.

The choice is a **pure function** (`chooseOrigin`, §10.3) so that the adapter
containing it has no branch of its own, and so that both halves are unit-tested
with no browser.

**`TAPKART_ORIGIN` is therefore not a container variable at all.** The server
answers with paths; `assetlinks.json` contains no origin (it is served *at* one).
The Plan 5 draft's compose file set it; that entry is **deleted**. A self-hoster
serving the PWA rebuilds nothing and configures no origin.

### 3.2 What CI can and cannot prove about this chain

**Can (§12.2):** 1 == 2 (both derived from one variable, asserted in the merged
manifest and in the built bundle); the path prefix in 1 equals
`LOBBY_PATH_PREFIX`; 4 == the `applicationId` inside the built APK; 5 == the
certificate CI just signed the APK with (`apksigner verify --print-certs`); and
that the **container** serves a shape-valid `assetlinks.json` at the right path
with the right content type and no redirect.

**Cannot:** that the origin the owner deploys behind Cloudflare Tunnel is that
container, or that Android's verifier succeeded. Those two are §14.1's owner
checklist, items 1 and 2.

---

## 4. `packages/invite` — module map and exact signatures

### 4.0 One dependency, and why it is not zero

The draft called this package "zero dependencies". C-7 makes that **false and
correct to change**: `ROOM_CODE_ALPHABET`, `ROOM_CODE_LENGTH`, `isValidRoomCode`
and `LOBBY_PATH_PREFIX` live in `@tapkart/protocol`, and a third implementation
of room-code validation inside `invite` is exactly the drift C-7 was decided to
stop. So:

```jsonc
// packages/invite/package.json
{ "name": "@tapkart/invite", "version": "0.1.0", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@tapkart/protocol": "*" },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }
```

```jsonc
// packages/invite/tsconfig.json — NO DOM lib, exactly like sim/protocol/net/content
{ "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"] }
```

`protocol` is itself DOM-free and dependency-free, so `invite` remains pure,
headless and safe for `server`, `game` and the Android build to reach. The name
is **`@tapkart/invite`, not `@tapkart/nfc`** (P5 Q1, already settled by R39),
because the package owns every way a guest gets into a lobby — tap, QR and typed
code all produce the same URI — and spec §2 is explicit that all three ship
together.

### 4.1 `src/hex.ts` — PURE

```ts
/** Uppercase, unseparated. The one spelling of hex in this repository. */
export function bytesToHex(b: Uint8Array): string
/** Accepts uppercase, lowercase and embedded spaces; throws on odd length or a
 *  non-hex character. Used by fixtures and by nothing shipped. */
export function hexToBytes(s: string): Uint8Array
```

### 4.2 `src/uri.ts` — PURE (mirrored in Kotlin, §7.3)

```ts
/** NFC Forum URI Record Type Definition, abbreviation table, index 0x00..0x23.
 *  Index 0x04 is 'https://' and is the only one this game ever emits. */
export const NDEF_URI_PREFIXES: readonly string[]

/** A short NDEF record's payload length field is one byte. 250 leaves margin
 *  under 255 for the 'https://' abbreviation and the room code. */
export const MAX_INVITE_URI_BYTES = 250

/** Single well-known URI record: MB=1 ME=1 CF=0 SR=1 IL=0 TNF=001 -> 0xD1,
 *  type 'U' (0x55), payload = [prefixCode, ...rest]. Throws if the encoded
 *  payload would exceed 255 bytes. Emits NO Android Application Record (§7.5). */
export function encodeUriRecord(uri: string): Uint8Array

/** Inverse. Throws on a record that is not a single well-known 'U' record. */
export function decodeUriRecord(rec: Uint8Array): string

/** NLEN (u16 big-endian) followed by the message. `null` yields exactly
 *  `[0x00, 0x00]` — a valid, empty, readable tag (§5.6). */
export function buildNdefFile(uri: string | null): Uint8Array

/** Inverse. Returns null for NLEN === 0. Throws if NLEN exceeds the buffer. */
export function parseNdefFile(file: Uint8Array): string | null
```

The URI is encoded as **UTF-8** and the length checks are in **bytes**, not
characters, in both languages. A room code is ASCII and an origin is punycode by
the time it reaches here, so this never bites in practice — which is exactly why
it must be pinned rather than discovered.

### 4.3 `src/invite.ts` — PURE

```ts
/** Origin cap, so `buildInviteUri` can never produce an un-encodable record and
 *  can never exceed the QR version cap. §5.9 does that arithmetic as a test. */
export const MAX_INVITE_ORIGIN_BYTES = 200

export interface InviteUri { origin: string; roomCode: string }

/** `buildInviteUri('https://tapkart.example', 'ABCDE')`
 *   -> 'https://tapkart.example/r/ABCDE'.
 *  Uses LOBBY_PATH_PREFIX from @tapkart/protocol — never a literal.
 *  Throws on a trailing slash in `origin`, on a non-https scheme, on an origin
 *  longer than MAX_INVITE_ORIGIN_BYTES, or on a room code that
 *  `isValidRoomCode` would reject. The room code is upper-cased first. */
export function buildInviteUri(origin: string, roomCode: string): string

/** Total: returns null rather than throwing, because its inputs come off a
 *  radio and off the address bar. Rejects any scheme but https, any path not
 *  starting with LOBBY_PATH_PREFIX, any malformed room code, and ANY query
 *  string or fragment (P5 Q14: the invite URI carries the room code and nothing
 *  else).
 *
 *  HAND-PARSED. It does not use `URL`: `URL` is an ambient global whose presence
 *  depends on the lib/@types configuration of whoever imports this package, and
 *  its normalisation silently accepts the query strings this function must
 *  reject. Twenty lines of explicit parsing has neither failure mode. */
export function parseInviteUri(uri: string): InviteUri | null

/** 'https://tapkart.example' -> 'tapkart.example'. null on anything that is not
 *  an https origin. Used by §12.2's manifest assertion (value 1 == value 2) and
 *  by nothing shipped. */
export function originHost(origin: string): string | null
```

### 4.4 `src/t4t.ts` — PURE (mirrored in Kotlin, §7.3)

```ts
/** NDEF Type 4 Tag application, NFC Forum registered: D2 76 00 00 85 01 01. */
export const NDEF_AID: Uint8Array
export const CC_FILE_ID = 0xe103
export const NDEF_FILE_ID = 0xe104

/** Max R-APDU data field we will ever return, and max C-APDU data field we
 *  accept. Published to the reader inside CC_FILE and enforced by processApdu. */
export const MLE = 0x00f6
export const MLC = 0x00ff
/** Max NDEF file size published in the CC. Includes the 2-byte NLEN. */
export const MAX_NDEF_FILE_SIZE = 0x0400

/** The 15-byte Capability Container, frozen. §5.3 breaks it down byte by byte. */
export const CC_FILE: Uint8Array

/** Every status word this tag can return. Two bytes each, big-endian. */
export const SW: {
  readonly ok: 0x9000
  readonly wrongLength: 0x6700
  readonly conditionsNotSatisfied: 0x6985
  readonly commandNotAllowed: 0x6986
  readonly wrongParameters: 0x6b00
  readonly fileNotFound: 0x6a82
  readonly incorrectP1P2: 0x6a86
  readonly insNotSupported: 0x6d00
  readonly claNotSupported: 0x6e00
}

export type SelectedFile = 'none' | 'app' | 'cc' | 'ndef'

export interface TagState {
  selected: SelectedFile
  ndefFile: Uint8Array        // NLEN + message; [0x00,0x00] when not advertising
}

export function createTagState(): TagState

/** Sole writer of `ndefFile`. `null` -> the empty file. Throws exactly where
 *  `buildNdefFile` throws, so an over-long URI fails at the call site rather
 *  than on the radio. Does NOT change `selected`. */
export function setNdefUri(state: TagState, uri: string | null): void

/** ISO-DEP link lost. Sole writer of `selected` besides processApdu.
 *  MUST be called from HostApduService.onDeactivated — see §5.6. */
export function resetTag(state: TagState): void

/** The whole tag, as a pure function. Returns a fresh Uint8Array containing
 *  the response data followed by the two status-word bytes. NEVER THROWS:
 *  every malformed input maps to a status word in the §5.5 table. */
export function processApdu(state: TagState, apdu: Uint8Array): Uint8Array
```

### 4.5 `src/reader.ts` — PURE

```ts
/** The guest-side half: the same exchange, driven. */
export function buildSelectAidApdu(): Uint8Array
export function buildSelectFileApdu(fileId: number): Uint8Array
/** `offset` 0..0xFFFF big-endian into P1P2; `length` 1..MLE. */
export function buildReadBinaryApdu(offset: number, length: number): Uint8Array
export function isStatusOk(resp: Uint8Array): boolean
/** The response minus its two status bytes. Empty array if there are none. */
export function responseBody(resp: Uint8Array): Uint8Array

/** One ISO-DEP round trip. Implemented by IsoDep on Android, by a loopback over
 *  `processApdu` in tests. */
export type Transceive = (command: Uint8Array) => Promise<Uint8Array>

/** SELECT app -> SELECT CC -> read CC -> SELECT NDEF -> read NLEN -> read body,
 *  chunked at the CC's advertised MLe. Returns the URI, or null if any step
 *  returns a non-9000 status or the message is empty. Never throws on a
 *  protocol error; propagates only errors thrown by `t` itself. */
export function readInvite(t: Transceive): Promise<string | null>
```

`readInvite` reads MLe **out of the CC it just read**, not out of the `MLE`
constant. A reader that trusts its own compiled-in value would work perfectly
against our own tag and fail against any other Type 4 tag, and the whole point of
implementing the reader is that it drives the same exchange a foreign reader
would.

### 4.6 `src/host.ts` — PURE (interfaces only)

```ts
export interface NfcSupport {
  /** Device has NFC hardware. */ hardware: boolean
  /** Device supports Host Card Emulation. */ hce: boolean
  /** NFC is switched on right now. */ adapterEnabled: boolean
}

/** Where an invite URI reached this device. F-P5-16 puts two entry points on one
 *  path; this is the only thing that distinguishes them, and it exists for the
 *  log line, not for a branch. */
export type InviteSource = 'tag' | 'appLink'

/** The seam. `apps/web` supplies a Capacitor-backed implementation on Android
 *  and `nullNfcHost` everywhere else. `packages/game` holds one and must never
 *  construct one. */
export interface NfcHost {
  supported(): Promise<NfcSupport>
  /** Idempotent. Starts emulating a tag serving `uri` and keeps the screen on. */
  advertise(uri: string): Promise<void>
  /** Idempotent. Serves the empty NDEF file and releases the screen lock. */
  stop(): Promise<void>
  /** Both entry points, one callback (F-P5-16). Returns an unsubscribe function. */
  onInvite(cb: (uri: string, source: InviteSource) => void): () => void
  /** The URI the launch intent carried, consumed once and then null.
   *
   *  Required, not convenience: a cold-start App Link is delivered before any JS
   *  has run, so `onInvite` cannot have been registered yet and the invite is
   *  silently lost without this. That is a tap that does nothing — the exact
   *  failure mode this plan is written to prevent. */
  pendingInvite(): Promise<string | null>
}

/** Every method resolves; `supported()` reports all false; `onInvite` returns a
 *  no-op unsubscribe; `pendingInvite()` resolves null. Browsers and desktop get
 *  this, and so does `startShell` when `opts.nfc` is absent. */
export const nullNfcHost: NfcHost
```

The draft's `onTagRead` is **replaced** by `onInvite`. F-P5-16's ruling is that
*"both filters deliver the same URI to the same handler… It is one path with two
entry points"* — two callbacks would be two paths, which is the objection the
ruling overruled, reintroduced by the back door.

### 4.7 `src/applinks.ts` — PURE

```ts
export const APP_LINKS_RELATION = 'delegate_permission/common.handle_all_urls'
export const ASSETLINKS_PATH = '/.well-known/assetlinks.json'

/** 32 uppercase hex byte pairs, colon separated: 95 characters exactly. */
export const FINGERPRINT_PATTERN: RegExp

export interface AssetLinksTarget {
  namespace: 'android_app'
  package_name: string
  sha256_cert_fingerprints: string[]
}
export interface AssetLinksStatement {
  relation: string[]
  target: AssetLinksTarget
}

export function isValidFingerprint(s: string): boolean
/** Splits on commas and whitespace, trims, upper-cases, drops empties.
 *  Throws naming the offending entry if any survivor fails validation. */
export function parseFingerprintList(raw: string): string[]
/** One statement, one target, N fingerprints. Throws on an empty list. */
export function buildAssetLinks(packageName: string, fingerprints: readonly string[]): AssetLinksStatement[]
/** Structural validation of parsed JSON from anywhere — a file, a fetch, a
 *  container. Returns a list of human-readable problems; `[]` means valid. */
export function validateAssetLinks(json: unknown): string[]

/** The environment variables the assetlinks generator reads, and the ONLY
 *  variables in the deployment that `packages/server`'s ENV_SCHEMA does not
 *  own. §11.4's drift test asserts the Dockerfile, the compose file and the
 *  README name exactly `ENV_SCHEMA ∪ ASSETLINKS_ENV_VARS`. */
export const ASSETLINKS_ENV_VARS: readonly ['TAPKART_ANDROID_PACKAGE', 'TAPKART_SHA256_FINGERPRINTS']
```

`isValidFingerprint` is deliberately strict about **case and separator**: Google's
verifier accepts what it accepts, but a repo that permits two spellings acquires
two spellings, and then the CI assertion comparing `apksigner`'s output to the
repo variable starts failing for a reason nobody can see. Upper-case, colon
separated, 95 characters. `parseFingerprintList` upper-cases on the way in, so
the owner may paste either.

### 4.8 `src/qr.ts` and `src/qr-tables.ts` — PURE

QR belongs to Plan 5 because **nobody else claimed it**: it appears in spec §2
and §11 as a hard requirement (*"QR and a … room code are always displayed
alongside… Nobody is ever blocked from joining"*), and it is absent from Plans
1–4. F-P5-2 rules it **hand-written**: byte mode, ECC-M, Reed–Solomon over
GF(256), masking, format info — *several hundred lines, and every one of them
pure, fully testable, and implementing an ISO spec that has not changed since
2006 and will not.*

```ts
// packages/invite/src/qr-tables.ts                                    PURE
/** The published constants the encoder must agree with. Every one of these is
 *  COMPUTED from the algorithm, never transcribed — §5.8 asserts each against a
 *  transcription of the published table, which is what makes the test evidence
 *  rather than a mirror. */

/** BCH(15,5) format information for ECC level M and the given mask (0..7),
 *  XORed with the published mask pattern. 15 bits, in the low bits. */
export function formatInfoBits(mask: number): number

/** The Reed-Solomon generator polynomial of the given degree over GF(256),
 *  coefficients high-order first, each an element (not a log). */
export function rsGeneratorPoly(ecCodewords: number): Uint8Array

/** Alignment-pattern centre coordinates for the version. Empty for version 1. */
export function alignmentCentres(version: number): readonly number[]

export interface QrBlockLayout {
  totalCodewords: number
  ecCodewordsPerBlock: number
  group1Blocks: number
  group1DataCodewords: number
  group2Blocks: number
  group2DataCodewords: number
}
/** ECC level M only — the only level this game emits. */
export function blockLayoutM(version: number): QrBlockLayout

/** Byte-mode data capacity in bytes at ECC-M for the version. */
export function byteCapacityM(version: number): number
```

```ts
// packages/invite/src/qr.ts                                           PURE
/** Row-major, `size * size` bytes, 1 = dark. Quiet zone NOT included; the
 *  drawer adds QR_QUIET_ZONE modules of margin. */
export interface QrMatrix { size: number; modules: Uint8Array }
export const QR_QUIET_ZONE = 4
export const QR_ECC_LEVEL = 'M'
/** Versions above this are unreachable: §5.8's arithmetic proves the longest
 *  invite URI this game can build fits inside byteCapacityM(QR_MAX_VERSION). */
export const QR_MAX_VERSION = 10

/** Byte mode, ECC level M, smallest version that fits, mask chosen by the
 *  published penalty rules. Throws above QR_MAX_VERSION. */
export function buildQrMatrix(text: string): QrMatrix
export function qrModuleAt(m: QrMatrix, x: number, y: number): boolean
```

`src/index.ts` re-exports `hex`, `uri`, `invite`, `t4t`, `reader`, `host`,
`applinks`, `qr`, `qr-tables` — all nine, because all nine are pure and
headless-safe. This package has no adapter half to keep out of the barrel.

---

## 5. The APDU exchange, byte by byte

### 5.1 Why this section is the longest one in the contract

This is **the one part of NFC that CI can genuinely test**. Two physical phones
cannot meet in a GitHub Actions runner, but the bytes they would exchange are a
pure function over byte arrays, and that function is implemented **twice** — once
in TypeScript (`processApdu`) and once in Kotlin (`T4tTag.process`) — and both are
driven from **one shared fixture** (§5.7).

Everything below is normative. A task that "simplifies" a status word or a CC
byte breaks the fixture, in both languages, loudly.

### 5.2 The command set — four commands, and nothing else

| # | Name | C-APDU (hex) | Precondition | Response |
|---|---|---|---|---|
| 1 | SELECT NDEF application, by DF name | `00 A4 04 00 07 D2 76 00 00 85 01 01` optionally followed by `00` (Le) | none | `90 00`; `selected := 'app'` |
| 2 | SELECT CC file, by file ID | `00 A4 00 0C 02 E1 03` | `selected !== 'none'` | `90 00`; `selected := 'cc'` |
| 3 | SELECT NDEF file, by file ID | `00 A4 00 0C 02 E1 04` | `selected !== 'none'` | `90 00`; `selected := 'ndef'` |
| 4 | READ BINARY | `00 B0 <offHi> <offLo> <Le>` | `selected` is `'cc'` or `'ndef'` | `<data> 90 00` |

Both spellings of command 1 (12 bytes, and 13 with a trailing `00` Le) are
accepted, because readers in the wild send both. The response carries **no FCI
template**; `90 00` alone is what Android's reader expects and what the fixture
pins.

`P2 = 0x0C` on commands 2 and 3 means "first or only occurrence, return no FCI".
`P1 = 0x00` means "select by file identifier". These are not free choices: they
are what the NFC Forum Type 4 Tag operation specifies, and an Android reader
sends exactly them.

**P1P2 on READ BINARY is a plain 16-bit big-endian offset.** ISO 7816-4's
alternative reading — P1 bit 8 set meaning "short EF identifier in P1, offset in
P2" — is **not supported**, and needs no special case: any P1 with bit 8 set
yields an offset ≥ 32768, which is past the end of a file capped at
`MAX_NDEF_FILE_SIZE`, so the existing `offset >= fileLength → 6B 00` rule already
covers it. One rule, no branch.

### 5.3 `CC_FILE`, byte by byte

```
00 0F   CCLEN = 15, the length of this file
20      Mapping version 2.0
00 F6   MLe = 246   — max R-APDU data field (MLE)
00 FF   MLc = 255   — max C-APDU data field (MLC)
04      NDEF File Control TLV, tag
06      NDEF File Control TLV, length
E1 04   NDEF file identifier            (NDEF_FILE_ID)
04 00   maximum NDEF file size = 1024   (MAX_NDEF_FILE_SIZE)
00      read access: granted
FF      write access: denied
```

Full hex: `000F2000F600FF0406E104040000FF` — 15 bytes (P5 Q18).

Write access is **denied**, permanently and by design. A writable emulated tag is
a way for a stranger's phone to change what the host is advertising.

`MLC = 255` is enforced vacuously and that is stated rather than hidden: a short
APDU's `Lc` is one byte and therefore never exceeds 255, and extended-length
APDUs are rejected outright (§5.4). The constant exists because the reader is
told it, not because a check depends on it.

### 5.4 The ordered algorithm both languages implement

The order matters, because two implementations that check the same conditions in
different orders return different status words for an APDU that violates two of
them at once — and the fixture would then fail with no bug present. Pinned:

```
processApdu(state, apdu):
  1. if apdu.length < 4                          -> SW.wrongLength        67 00
  2. if apdu[0] !== 0x00                         -> SW.claNotSupported    6E 00
  3. if apdu[1] !== 0xA4 && apdu[1] !== 0xB0     -> SW.insNotSupported    6D 00
  4. parse the length triple:
       len === 4                    -> case 1: no data, no Le
       len === 5                    -> case 2: Le = apdu[4], 0x00 means 256
       apdu[4] === 0x00 && len > 5  -> SW.wrongLength 67 00   (extended length)
       len === 5 + apdu[4]          -> case 3: Lc = apdu[4], data follows
       len === 6 + apdu[4]          -> case 4: Lc = apdu[4], data, then Le
       otherwise                    -> SW.wrongLength 67 00
  5. if INS === 0xA4: SELECT
       P1P2 === 0x0400 -> select by name: requires case 3 or 4 and Lc data
                          equal to NDEF_AID, else SW.fileNotFound 6A 82.
                          On success: selected := 'app'.
       P1P2 === 0x000C -> select by id: requires selected !== 'none'
                          (else SW.conditionsNotSatisfied 69 85), case 3 or 4,
                          Lc === 2, and the file id CC_FILE_ID or NDEF_FILE_ID
                          (else SW.fileNotFound 6A 82).
                          On success: selected := 'cc' | 'ndef'.
       otherwise       -> SW.incorrectP1P2 6A 86
       Response is SW.ok alone. No FCI.
  6. if INS === 0xB0: READ BINARY
       requires case 2 (a bare Le). Any other case -> SW.wrongLength 67 00.
       if selected is 'none' or 'app'  -> SW.commandNotAllowed 69 86
       file := selected === 'cc' ? CC_FILE : state.ndefFile
       offset := (apdu[2] << 8) | apdu[3]
       if offset >= file.length        -> SW.wrongParameters 6B 00
       want := apdu[4] === 0x00 ? 256 : apdu[4]
       n := min(want, MLE, file.length - offset)
       response := file[offset .. offset+n) followed by SW.ok
```

Steps 1–3 come before the case parse deliberately: an APDU with a bad CLA and a
bad length is reported as a bad CLA, in both languages, forever.

### 5.5 The error table

| Condition | SW |
|---|---|
| APDU shorter than 4 bytes | `67 00` |
| `CLA !== 0x00` | `6E 00` |
| `INS` not `A4` or `B0` | `6D 00` |
| a length triple that does not parse as ISO 7816 case 1–4, or an extended-length APDU | `67 00` |
| READ BINARY that is not case 2 | `67 00` |
| SELECT with `P1P2` neither `0400` nor `000C` | `6A 86` |
| SELECT by name with an AID that is not `NDEF_AID` | `6A 82` |
| SELECT by ID with a file ID other than `E103`/`E104` | `6A 82` |
| SELECT by ID while `selected === 'none'` | `69 85` |
| READ BINARY while `selected` is `'none'` or `'app'` | `69 86` |
| READ BINARY with `offset >= fileLength` | `6B 00` |

**Over-reading is truncated, not rejected** (P5 Q19). `min(Le, MLE, fileLength -
offset)` bytes come back with `90 00`. Android's Type 4 reader never over-reads —
it reads NLEN first and chunks at MLe — so the lenient branch is never taken by
the reader we care about; being lenient means an unusual reader gets a usable
answer instead of a dead tag. `6C XX` would be correctness theatre for readers we
do not target.

`offset >= fileLength` is **not** truncation, it is `6B 00`. There is no
legitimate reason to start a read past the end of a file whose length the reader
was just told.

### 5.6 The advertising and non-advertising states, and `resetTag`

`TagState.ndefFile` is **always a valid file**. It is `00 00` (NLEN = 0) when the
host is not advertising, and NLEN-prefixed message bytes when it is (P5 Q21).

Selects always succeed regardless. A reader that taps a non-advertising host gets
a well-formed **empty** tag and does nothing — which is exactly right, and
strictly better than a `6A 82` that some readers surface to the user as a broken
tag.

`selected` resets to `'none'` on `resetTag`, which the Android service calls from
`onDeactivated`. **This is the single most likely Kotlin-side bug in the plan:**
an HCE service instance is reused across taps, so a state machine that does not
reset starts the second tap mid-conversation, and the second guest of the evening
gets nothing while the first got everything. §13 makes it a sole-writer rule and
§5.7 makes it a fixture case, because "the first tap of the day works perfectly"
is exactly the profile of a bug that ships.

### 5.7 The golden exchange — the fixture both languages replay

For `TAPKART_ORIGIN = https://tapkart.example` and room code `ABCDE`
(**five** characters, F-P4-34), the invite URI is
`https://tapkart.example/r/ABCDE` — 31 characters.

The NDEF record abbreviates `https://` to prefix code `0x04`, leaving the 23
ASCII bytes of `tapkart.example/r/ABCDE`:

```
D1        MB=1 ME=1 CF=0 SR=1 IL=0 TNF=001  (single short well-known record)
01        type length = 1
18        payload length = 24  (1 prefix byte + 23 URI bytes)
55        type 'U'
04        prefix code: 'https://'
7461706B6172742E6578616D706C652F722F4142434445   'tapkart.example/r/ABCDE'
```

Record length = 28, so `NLEN = 00 1C` and the NDEF file is **30 bytes**:

```
001CD1011855047461706B6172742E6578616D706C652F722F4142434445
```

The full exchange, which is what `packages/invite/vectors/t4t-exchange.tsv`
contains — including the two-step CC read a real Android reader performs:

| Step | → Command | ← Response | `selected` after |
|---|---|---|---|
| 1 | `00A4040007D276000085010100` | `9000` | `app` |
| 2 | `00A4000C02E103` | `9000` | `cc` |
| 3 | `00B0000002` | `000F` `9000` | `cc` |
| 4 | `00B000020D` | `2000F600FF0406E104040000FF` `9000` | `cc` |
| 5 | `00A4000C02E104` | `9000` | `ndef` |
| 6 | `00B0000002` | `001C` `9000` | `ndef` |
| 7 | `00B000021C` | `D1011855047461706B6172742E6578616D706C652F722F4142434445` `9000` | `ndef` |

Plus the one-shot 15-byte CC read (`00B000000F` →
`000F2000F600FF0406E104040000FF` `9000`), the non-advertising path (after
`setNdefUri(null)`: steps 1, 5 and 6 give `9000`, `9000`, `0000` `9000`), and
every negative case, in the same file:

| → Command | Precondition | ← Response |
|---|---|---|
| `00A4040007A0000002471001` | — | `6A82` (wrong AID) |
| `00A4040107D2760000850101` | — | `6A86` (P1P2 `0401`) |
| `00A4000C02E105` | `selected = 'app'` | `6A82` (unknown file id) |
| `00A4000C02E103` | after `resetTag` | `6985` |
| `00B0000002` | after `resetTag` | `6986` |
| `00B0000002` | `selected = 'app'` | `6986` |
| `80B0000002` | — | `6E00` (CLA) |
| `00C0000000` | — | `6D00` (INS) |
| `00A4` | — | `6700` (short) |
| `00B00000` | `selected = 'ndef'` | `6700` (READ BINARY, case 1) |
| `00B0FFFF02` | `selected = 'ndef'`, 30-byte file | `6B00` |
| `00B0001C40` | `selected = 'ndef'`, 30-byte file | `4445` `9000` (over-read, truncated) |

The last row is the truncation case (§5.5) and it is written out so nobody
"fixes" it: offset `0x001C` = 28 is inside the 30-byte file and `Le` = 64, so the
tag returns the **final two bytes** — `44 45`, the `DE` of `ABCDE` — and `90 00`,
rather than `6C 02`.

**Then the whole happy path is replayed after a `resetTag`**, asserting that step
6 from a reset state returns `6986` — the second-tap-of-the-evening case.

### 5.8 Fixture format — line-oriented, not JSON

```
# t4t-exchange.tsv — version 1
# NAME <TAB> NDEF_URI <TAB> RESET_BEFORE <TAB> COMMAND_HEX <TAB> RESPONSE_HEX <TAB> SELECTED_AFTER
selectApp	https://tapkart.example/r/ABCDE	1	00A4040007D276000085010100	9000	app
selectCc	.	0	00A4000C02E103	9000	cc
readNlenEmpty	-	1	00B0000002	6986	none
```

Five columns and a name. `#` comments, uppercase unseparated hex, one exchange
per line, applied **in file order** against one `TagState`:

- `NDEF_URI` — `.` leaves the tag as it is; `-` calls `setNdefUri(state, null)`;
  anything else calls `setNdefUri(state, thatUri)`. **The draft's format had no
  such column and therefore could not express the non-advertising cases §5.6
  promises.**
- `RESET_BEFORE` — `1` calls `resetTag(state)` before the command, `0` does not.
  A `1` is what starts a new conversation.
- `SELECTED_AFTER` — `none` | `app` | `cc` | `ndef`, compared after every line.

A second file, `packages/invite/vectors/ndef-uri.tsv`, is
`URI <TAB> NDEF_FILE_HEX`, with a line whose URI column is `-` for the empty file
`0000`.

**Not JSON, deliberately** (P5 Q20). `org.json` is stubbed in Android JVM unit
tests (`testOptions.unitTests.returnDefaultValues` either throws or silently
returns zeros), so a JSON fixture forces a JSON dependency onto the Android test
classpath to read a file that has no nesting in it. Ten lines of `split('\t')` on
each side has no such failure mode.

Both suites read the same two files:

- vitest: `packages/invite/test/vectors.test.ts` reads them with `node:fs`, the
  same test-only disk reach Plan 2 §6 and Plan 3 ruling Q34 already permit.
- Gradle: the Android module adds
  `sourceSets["test"].resources.srcDir("$rootDir/../../packages/invite/vectors")`
  and the Kotlin test reads them off the test classpath. Repo-relative, no host
  path. (If P5 Q9's flattening branch changes `rootDir`, this path shifts with it
  and the task adjusts it — §6.1.)

**Both suites must fail when the fixture file is missing or empty.** A vector
runner that iterates zero rows and reports success is this project's signature
defect, and it is the specific way this particular test would rot.

**What this proves:** the two implementations agree, byte for byte, on every
command in the table including the error cases. **What it does not prove:** that
any of it happens over a radio. §14.

### 5.9 QR reference vectors — never the encoder's own output

F-P5-2: *"Test against published reference vectors, never against the encoder's
own output. A QR encoder that round-trips with itself and produces a code no
phone can read is exactly this project's signature defect in a new costume."*

Made concrete, in three layers, and the contract fixes the **format and the
required contents**, not the numbers — the numbers are transcribed by the
implementing task from the published tables, and **no number in this contract may
be used as their source**:

1. **`packages/invite/vectors/qr-reference.tsv`** carries, one per line, with the
   published table cited in a `SOURCE` column on the line itself:
   - the 8 format-information bit strings for **ECC level M**, masks 0–7
     (ISO/IEC 18004 format-information table);
   - the Reed–Solomon generator polynomials for every EC-codeword count that
     versions 1–10 at ECC-M use;
   - the alignment-pattern centre coordinates for versions 2–10;
   - the block layout (total codewords, EC codewords per block, group counts and
     data codewords per block) for versions 1–10 at ECC-M;
   - the byte-mode data capacity for versions 1–10 at ECC-M.

   The encoder **computes** each of these — format info by BCH(15,5) plus the
   published XOR mask, the generator polynomials by multiplying out over GF(256),
   the alignment centres by the published spacing rule. The test asserts the
   computed value equals the transcribed published value. **That is the
   independence the ruling demands: a transcription is evidence about a
   computation; a computation compared to itself is not.**

2. **One complete published symbol.**
   `packages/invite/vectors/qr-symbol.txt` holds a full module matrix
   transcribed from a published worked example, with the citation in its header,
   and `buildQrMatrix` must reproduce it module for module. It must be a
   **byte-mode, ECC-M** symbol, because that is the only mode this encoder emits;
   the implementing task cites whichever published example it uses.

3. **The arithmetic that keeps us inside the cap**, as a test rather than a
   comment:

   ```
   MAX_INVITE_ORIGIN_BYTES + LOBBY_PATH_PREFIX.length + ROOM_CODE_LENGTH
       <= byteCapacityM(QR_MAX_VERSION)
   ```

   Every term is imported — two from `@tapkart/protocol`, two from `invite` — so
   the day Plan 4 lengthens a room code or renames the prefix, this test says so
   instead of a phone failing to scan. The test reads the capacity from the
   transcribed table; it does not trust any capacity written in prose here.

**Still not proven, and stated in §14:** that a camera can read the thing on a
real screen at a real size in real light.

---

## 6. `apps/android` — the Capacitor project

### 6.1 Layout and identity

```
apps/android/
  capacitor.config.ts        webDir: '../web/dist',  android: { path: '.' }
  package.json               workspace member; pins @capacitor/* (§6.6)
  settings.gradle.kts
  build.gradle.kts
  gradle/wrapper/            wrapper jar + properties, committed
  gradlew, gradlew.bat
  app/
    build.gradle.kts         applicationId, signingConfigs, manifestPlaceholders
    src/main/AndroidManifest.xml
    src/main/res/xml/apduservice.xml
    src/main/res/xml/config.xml                              (Capacitor)
    src/main/kotlin/io/github/atvriders/tapkart/MainActivity.kt
    src/main/kotlin/io/github/atvriders/tapkart/TapkartNfcPlugin.kt
    src/main/kotlin/io/github/atvriders/tapkart/nfc/*.kt
    src/test/kotlin/io/github/atvriders/tapkart/nfc/*Test.kt JVM, no device
```

- **P5 Q9 is a verify-then-branch, not a judgment.** Flatten to the layout above
  **if** the pinned Capacitor major honours `android.path`; otherwise fall back to
  Capacitor's nested layout (`apps/android/android/…`) and shift every path in
  §6, §5.8 and §12.2 by one directory. The task verifies at pin time (§6.6) and
  records which branch it took, in the same table.
- `applicationId = "io.github.atvriders.tapkart"` (P5 Q12 — the org is public in
  the spec's first line; the alternatives claim domains we do not own),
  overridable by the Gradle property `tapkartApplicationId`. It must equal
  `TAPKART_ANDROID_PACKAGE` in the deployment (§3, value 4).
- `namespace` equals the `applicationId`.
- Web assets are copied in by `npx cap sync android`; the copy
  (`app/src/main/assets/public/`) is **gitignored** (§1). **The APK bundles the
  PWA** (F-P5-10) and works offline; it does **not** point a WebView at a remote
  origin, because *offline is a requirement (F-P5-26) and a WebView pointed at a
  remote origin is useless without network — the opposite of what a PWA is for.*

### 6.2 `AndroidManifest.xml` — the structure CI asserts

```xml
<uses-permission android:name="android.permission.NFC"/>
<uses-permission android:name="android.permission.INTERNET"/>
<uses-feature android:name="android.hardware.nfc" android:required="false"/>
<uses-feature android:name="android.hardware.nfc.hce" android:required="false"/>
```

`required="false"` on both, deliberately: only the **host** needs NFC, and a guest
with a non-NFC phone must still be able to install the APK and play. Marking the
feature required would exclude them from the install.

```xml
<activity
    android:name=".MainActivity"
    android:exported="true"
    android:launchMode="singleTask"
    android:screenOrientation="sensorLandscape"
    android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode">

  <intent-filter>
    <action android:name="android.intent.action.MAIN"/>
    <category android:name="android.intent.category.LAUNCHER"/>
  </intent-filter>

  <!-- Entry point 1: App Links. The ONLY path that works on Android 16+. -->
  <intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW"/>
    <category android:name="android.intent.category.DEFAULT"/>
    <category android:name="android.intent.category.BROWSABLE"/>
    <data android:scheme="https" android:host="${tapkartHost}" android:pathPrefix="/r/"/>
  </intent-filter>

  <!-- Entry point 2 (F-P5-16): catches the app-installed case on Android 15 and
       earlier, where an NDEF tag still fires ACTION_NDEF_DISCOVERED. Four lines.
       Same URI, same handler, same code path — asserted by §7.3's uriFrom. -->
  <intent-filter>
    <action android:name="android.nfc.action.NDEF_DISCOVERED"/>
    <category android:name="android.intent.category.DEFAULT"/>
    <data android:scheme="https" android:host="${tapkartHost}" android:pathPrefix="/r/"/>
  </intent-filter>
</activity>

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

**F-P5-16, in the ruling's own terms:** *"Four lines that catch the app-installed
case on Android 15 and earlier — spec §2's argument is specifically about Android
16+ behaviour, so leaving it out silently degrades every older device. The 'two
code paths' objection does not survive inspection: both filters deliver the same
URI to the same handler."* The second filter carries **no** `autoVerify` — it is
not an App Link and verification does not apply to it.

`launchMode="singleTask"` is required, not cosmetic: without it, a verified App
Link opened while the app is already running starts a *second* task and the guest
lands on a fresh title screen instead of the lobby they were invited to.

The two `pathPrefix` values are **generated from `LOBBY_PATH_PREFIX`**, not typed:
§12.2's assertion compares the merged manifest's value against the constant
imported from `@tapkart/protocol`, which is what makes C-1's freeze mechanical.

### 6.3 `res/xml/apduservice.xml`

```xml
<host-apdu-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/hce_service_description"
    android:requireDeviceUnlock="true">
  <aid-group android:description="@string/hce_aid_group_description"
             android:category="other">
    <aid-filter android:name="D2760000850101"/>
  </aid-group>
</host-apdu-service>
```

`requireDeviceUnlock="true"` (P5 Q15) matches spec §2's stated limit — *"The
host's screen must be on and unlocked for HCE to respond"* — rather than quietly
widening it. Changing it is a spec amendment, not a manifest attribute.

### 6.4 The five behaviours that are decisions, not implementation detail

1. **`startAdvertising` sets `FLAG_KEEP_SCREEN_ON` on the activity window, and
   `stopAdvertising` clears it.** Spec §2: HCE does not answer with the screen
   off. A host whose phone sleeps while the lobby is open has silently stopped
   being tappable, and no amount of correct APDU handling fixes it.
2. **`startAdvertising` calls `CardEmulation.setPreferredService(activity, component)`
   and `stopAdvertising` calls `unsetPreferredService`** (P5 Q17). AID
   `D2760000850101` in category `other` can be claimed by more than one installed
   app; the preferred-service call is the only defence against another app
   winning, and it costs an activity reference the lobby already has.
3. **The advert is cleared on pause** (F-P5-45). `handleOnPause` calls the same
   path `stopAdvertising` does: `LobbyAdvert.uri = null`, `unsetPreferredService`,
   clear `FLAG_KEEP_SCREEN_ON`. *Spec §2 already says a sleeping screen stops HCE,
   so leaving the advert set buys only the narrow backgrounded-but-awake window —
   in exchange for a failure that is **mysterious rather than predictable**. A tap
   that fails the same way every time is debuggable by the owner and explainable
   to a guest; one that works only while the screen happens to be on is neither.*

   **Consequence, and it deletes code the draft had:** `LobbyAdvert` keeps **no
   SharedPreferences persistence**. The draft's `load(context)`/`store(context, …)`
   and its `PREFS_NAME`/`KEY_LOBBY_URI` constants are **removed**. Restoring an
   advert across process death is precisely the backgrounded-host tap this ruling
   makes fail on purpose, so persisting it would resurrect the behaviour the
   ruling deleted.
4. **Reader mode is enabled only while the guest is on a screen that can act on a
   tap** (P5 Q23), with flags `FLAG_READER_NFC_A | FLAG_READER_NFC_B |
   FLAG_READER_SKIP_NDEF_CHECK | FLAG_READER_NO_PLATFORM_SOUNDS`, and it is
   disabled in `handleOnPause`. Always-on reader mode intercepts every transit
   card and hotel key the phone touches while the app is open. Skipping the
   platform NDEF check is what stops Android from also firing its own dispatch for
   the tag we are reading.
5. **A tag read whose URI does not `parseInviteUri` is dropped silently.** The
   guest's phone will be tapped against transit cards and hotel keys; a modal
   error for each is worse than nothing happening.

### 6.5 Signing

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

- The keystore is **generated once by the owner, out of band**, before the first
  release build, and backed up the day it is created (spec §9; spec §11's
  *"Losing the signing keystore"* row). The repo documents *how* in `README.md`
  (P5 Q40) and never carries the artifact.
- In CI, `ANDROID_KEYSTORE_BASE64` is decoded to `$RUNNER_TEMP`, **never into the
  workspace**, and never uploaded as an artifact.
- A build with no keystore env produces an **unsigned** release APK, and CI fails
  it at §12.2's fingerprint check rather than shipping it. Debug builds sign with
  the local debug keystore as usual and are never released.
- Spec §2 permits `assetlinks.json` to list several fingerprints so a
  locally-built debug APK also verifies (P5 Q36). That is supported by
  `TAPKART_SHA256_FINGERPRINTS` being a **list**; the debug fingerprint is the
  owner's local machine's and therefore never enters the repo.

**Why this is day one and not v2, restated because it is the most expensive thing
in the plan to get wrong:** spec §2 — *"Gradle auto-generates
`~/.android/debug.keystore` when absent, and a GitHub Actions runner is a fresh
VM every run, so every CI build would carry a different certificate and no static
`assetlinks.json` could ever match."*

### 6.6 Version pins — by rule, then recorded (F-P5-31)

*"Neither draft could verify these and neither should invent them."* The binding
constraints:

| Pin | Rule |
|---|---|
| Capacitor major | Pinned in `apps/android/package.json`, per spec §9 |
| AGP, Gradle wrapper, Kotlin plugin | Taken from that Capacitor version's template **unmodified** |
| `targetSdk` | **≥ the Android 16 API level.** Spec §2's entire argument is about Android 16 behaviour; a lower target opts out of it |
| `compileSdk` | **`= targetSdk`** |
| `minSdk` | **`max(the pinned Capacitor major's floor, 26)`.** HCE needs API 19, so Capacitor's floor is what actually binds; 26 is the sensible modern floor and picking it too low silently ships to devices nothing was tested on |
| JDK | 21 in CI (spec §9, P5 Q32) |

**The implementing task reads the template's actual values and writes them into
this table**, together with the Android 16 API level it read from the SDK
platform it installed and the P5 Q9 layout branch it took. That is the honest
form of this pin: **no number in this contract is a source for any of them.**

CI then asserts the *relations* rather than the values (§12.2): `compileSdk ==
targetSdk`, `targetSdk >= <recorded Android 16 API level>`, `minSdk >= 26`. A
relation survives an SDK bump; a hardcoded number becomes a lie the day the
template moves.

---

## 7. Kotlin — the second implementation

### 7.1 What is mirrored, and what is not

Only the **pure** half is written twice. The Kotlin side implements the NDEF
encoder and the Type 4 tag state machine and nothing else; it does not implement
`parseInviteUri`, `buildInviteUri` or the QR encoder, because nothing on the
Android side needs them — the WebView does that work in TypeScript.

That split is deliberate and it is what keeps the two-language cost at one
fixture: everything mirrored is driven by `t4t-exchange.tsv` and `ndef-uri.tsv`
(§5.7, §5.8), and everything not mirrored has exactly one implementation.

### 7.2 `nfc/Hex.kt` — PURE

```kotlin
package io.github.atvriders.tapkart.nfc

object Hex {
    fun encode(bytes: ByteArray): String            // uppercase, unseparated
    fun decode(s: String): ByteArray                // tolerant of spaces and case
}
```

### 7.3 `nfc/NdefUri.kt`, `nfc/T4tTag.kt`, `nfc/InviteIntent.kt` — PURE, and byte-identical to the TypeScript

```kotlin
// NdefUri.kt — mirrors packages/invite/src/uri.ts exactly.
object NdefUri {
    const val MAX_INVITE_URI_BYTES: Int = 250
    fun encodeUriRecord(uri: String): ByteArray
    fun buildNdefFile(uri: String?): ByteArray      // null -> byteArrayOf(0, 0)
    fun parseNdefFile(file: ByteArray): String?
}

// T4tTag.kt — mirrors packages/invite/src/t4t.ts exactly, including §5.4's order.
class T4tTag {
    enum class Selected { NONE, APP, CC, NDEF }

    val selected: Selected                          // read-only to callers
    fun setUri(uri: String?)                        // sole writer of the NDEF file
    fun reset()                                     // sole writer of selected, besides process()
    fun process(apdu: ByteArray): ByteArray         // NEVER throws

    companion object {
        val AID: ByteArray                          // D2760000850101
        val CC_FILE: ByteArray                      // the 15 bytes of §5.3
        const val MLE: Int = 0x00F6
        const val MLC: Int = 0x00FF
    }
}

// InviteIntent.kt — the whole of F-P5-16's "one path, two entry points", as a
// pure function, so "both intents resolve identically" is a unit test and not a
// claim.
object InviteIntent {
    const val ACTION_VIEW: String = "android.intent.action.VIEW"
    const val ACTION_NDEF_DISCOVERED: String = "android.nfc.action.NDEF_DISCOVERED"

    /** The URI to hand to the web layer, or null. Accepts exactly the two
     *  actions above and nothing else; returns `dataUri` unchanged when it is
     *  non-null and non-blank. It does NOT parse the invite — `parseInviteUri`
     *  is TypeScript's and runs once, in the WebView, for both entry points. */
    fun uriFrom(action: String?, dataUri: String?): String?
}
```

The Kotlin unit test asserts `uriFrom(ACTION_VIEW, u) == uriFrom(ACTION_NDEF_DISCOVERED, u)`
over a table of URIs including the empty string, a blank string and `null` — which
is F-P5-16's *"a test asserts both intents resolve identically"*, discharged.

### 7.4 The adapters

```kotlin
// nfc/LobbyAdvert.kt — ADAPTER (one process-global, and nothing else)
object LobbyAdvert {
    /** Sole writer: TapkartNfcPlugin. TapkartHceService reads it and never
     *  writes it. Not persisted anywhere — see §6.4 rule 3. */
    @Volatile var uri: String?
}

// nfc/TapkartHceService.kt — ADAPTER
class TapkartHceService : HostApduService() {
    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray
    override fun onDeactivated(reason: Int)         // MUST call tag.reset() — §5.6
}

// nfc/InviteReader.kt — ADAPTER
object InviteReader {
    /** Wraps IsoDep in the §5.2 exchange and runs it. Returns the URI or null.
     *  Connect and close are its responsibility. */
    fun read(isoDep: IsoDep): String?
}
```

```kotlin
package io.github.atvriders.tapkart

// TapkartNfcPlugin.kt — ADAPTER (the Capacitor bridge)
@CapacitorPlugin(name = "TapkartNfc")
class TapkartNfcPlugin : Plugin() {
    @PluginMethod fun isSupported(call: PluginCall)       // -> { hardware, hce, adapterEnabled }
    @PluginMethod fun startAdvertising(call: PluginCall)  // { uri: String }
    @PluginMethod fun stopAdvertising(call: PluginCall)
    @PluginMethod fun startReader(call: PluginCall)       // emits 'inviteUri' { uri, source: 'tag' }
    @PluginMethod fun stopReader(call: PluginCall)
    @PluginMethod fun getPendingInvite(call: PluginCall)  // -> { uri: string | null }, consumed once

    override fun handleOnNewIntent(intent: Intent)        // -> InviteIntent.uriFrom -> 'inviteUri' { source: 'appLink' }
    override fun handleOnPause()                          // stops reader mode AND clears the advert (§6.4 rule 3)
    override fun handleOnResume()                          // restores reader mode if it was on
}

// MainActivity.kt — ADAPTER
class MainActivity : BridgeActivity()                     // registers TapkartNfcPlugin
```

`getPendingInvite` exists because a cold-start App Link is delivered to
`onCreate`'s intent **before any JavaScript has run**, so no `addListener` can
have been registered. Without it, the very first tap into a not-yet-running app —
the single most likely real tap in the product — is silently dropped. It is
consumed once and returns `null` thereafter, so a later reload does not re-join a
dead room.

`handleOnPause` clearing the advert is the one place two rulings meet:
`stopReader` (P5 Q23) and `stopAdvertising` (F-P5-45) are both driven from it, so
a paused app is neither reading nor readable.

### 7.5 No Android Application Record

The NDEF message contains a URI record and nothing else (P5 Q22). An AAR
(`android.com:pkg`) would send a guest **without** the app to a Play Store page
for an app that is not on the Play Store — and this game is distributed as a
GitHub Release asset (spec §9) — which breaks exactly the row of spec §2's table
that must work. App Links already routes the URL into the app when the app *is*
installed; the AAR buys nothing and costs a dead end.

---

## 8. PWA — manifest, service worker, offline, install

All of this lands in `apps/web`, which **Plan 3 already created** as a Vite shell
(Plan 3 ruling Q11, and Plan 3 also made the root `workspaces` and
`vitest.config.ts` edits — R36/R37 — so the Plan 5 draft's first two "edits"
rows are gone). Plan 5 adds:

### 8.1 File map

```
apps/web/
  public/manifest.webmanifest
  public/icons/            generated at build, gitignored
  src/pwa/policy.ts        PURE   the whole caching policy
  src/pwa/update.ts        PURE   update reducer
  src/pwa/install.ts       PURE   install-prompt reducer
  src/pwa/origin.ts        PURE   C-3's choice, as a function (§10.3)
  src/sw.ts                ADAPTER service worker entry — its OWN tsconfig (§8.4)
  src/platform/env.ts      ADAPTER reads import.meta.env, location, Capacitor
  src/platform/nfc.ts      ADAPTER Capacitor bridge -> NfcHost
  src/platform/audio.ts    ADAPTER the only AudioContext constructor
  tools/precache.mjs       build tool
  tools/png.mjs            build tool
  tools/build-sw.mjs       build tool
  tools/write-assetlinks.ts  container entrypoint tool, bundled by esbuild
  test/*.test.ts
```

### 8.2 `public/manifest.webmanifest`

```json
{
  "id": "/",
  "name": "Tapkart",
  "short_name": "Tapkart",
  "start_url": "/",
  "scope": "/",
  "display": "fullscreen",
  "display_override": ["fullscreen", "standalone"],
  "orientation": "landscape",
  "background_color": "#0B0D10",
  "theme_color": "#0B0D10",
  "categories": ["games"],
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`"orientation": "landscape"` is **not an independent decision** — Plan 3 §0's
orientation row says so in those words: *"landscape only (R40)… Plan 5's PWA
manifest `"orientation": "landscape"` is a consequence of this line."* The shell
already shows a rotate-your-device overlay.

`scope: "/"` covers `/r/ABCDE`, so a guest who installs after arriving by tap
keeps the invite inside the app's scope. `start_url` is `/` because a saved
invite code is stale the moment the room expires.

Icons are **generated at build time** (P5 Q27) by `tools/png.mjs` into
`public/icons/`, which is gitignored — no binaries in git, and the generator is a
pure function CI can assert (`encodePng` emits a correct signature, IHDR and CRC;
`drawIconRgba` is deterministic).

### 8.3 The caching policy — pure, and the sole decider

```ts
// apps/web/src/pwa/policy.ts                                          PURE
/** A plain struct, deliberately (P5 Q47): the pure layer never names `Request`,
 *  so these tests need no DOM and no jsdom (Plan 3 ruling Q30). sw.ts converts. */
export interface SwRequestInfo {
  method: string
  url: string                 // absolute
  sameOrigin: boolean
  isNavigate: boolean
}

export type SwRouteAction =
  | 'passthrough'     // not ours: do not call respondWith at all
  | 'cacheFirst'      // precached, content-hashed, immutable
  | 'networkFirst'    // fall back to cache
  | 'networkOnly'     // never cache, never serve stale
  | 'shellFallback'   // navigation: network, else the cached shell

export interface SwRoute { action: SwRouteAction; cacheKey: string }

export interface SwConfig {
  cacheName: string           // `tapkart-${version}`
  precache: readonly string[] // absolute paths, from the build manifest
  shellPath: string           // '/index.html'
  neverCachePrefixes: readonly string[]
}
export const NEVER_CACHE_PREFIXES: readonly string[]
export const DEFAULT_SW_CONFIG: Readonly<SwConfig>

/** Total. Sole decider of every caching decision in the app. */
export function routeRequest(info: SwRequestInfo, cfg: SwConfig): SwRoute
```

The routing rules, pinned, and evaluated **in this order**:

| # | Request | Action |
|---|---|---|
| 1 | method !== `GET` | `passthrough` |
| 2 | cross-origin | `passthrough` |
| 3 | path starts with any of `NEVER_CACHE_PREFIXES` — `/.well-known/`, `/api/`, `/signal`, `/ws`, `/healthz` | `networkOnly` |
| 4 | `isNavigate` | `shellFallback` |
| 5 | path is in `cfg.precache` | `cacheFirst` |
| 6 | any other same-origin GET | `networkFirst` |

Rule 3 before rule 4 is load-bearing: `/.well-known/assetlinks.json` fetched by a
navigation must never be answered out of the shell cache.

`/.well-known/` being `networkOnly` is **not** about the Android verifier — that
fetch never passes through a page's service worker — it is so a developer never
debugs a stale `assetlinks.json` served out of a browser cache.

### 8.4 The service worker, and the tsconfig split GAP-5 forced

```ts
// apps/web/src/sw.ts                                                  ADAPTER
// `const sw = self as unknown as ServiceWorkerGlobalScope` — pinned idiom, so
// two tasks do not invent two ways to type `self`. There is NO
// `/// <reference lib="webworker" />` anywhere in this repository.
```

**GAP-5, and the draft's answer does not work.** Plan 3 §10.1 gives `apps/web`
`"lib": ["ES2022", "DOM", "DOM.Iterable"]` with `"include": ["src/**/*.ts",
"vite.config.ts"]`. TypeScript's `dom` and `webworker` libs **cannot coexist in
one compilation** — `self`, `fetch`, `AbortController`, `EventTarget` and dozens
more are declared in both — so the draft's single `/// <reference lib="webworker" />`
inside that program is a duplicate-identifier error, not an idiom, and
`npm run typecheck` fails the moment `sw.ts` lands.

The resolution (P5 Q41), concretely:

```jsonc
// apps/web/tsconfig.json  — Plan 3's file, edited by Plan 5
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"] },
  "include": ["src/**/*.ts", "tools/**/*.ts", "vite.config.ts"],
  "exclude": ["src/sw.ts"] }

// apps/web/tsconfig.sw.json — new, and the ONLY program that sees WebWorker
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "WebWorker"], "types": [] },
  "include": ["src/sw.ts", "src/pwa/policy.ts"] }
```

```jsonc
// apps/web/package.json
"typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.sw.json"
```

Three things in that are not decoration:

- **`"types": []`** on the worker program. Without it `@types/node` (a root
  devDependency, in scope everywhere because no program restricts `types`)
  contributes its own `fetch`, `Blob`, `Event`, `EventTarget` and `MessageEvent`
  globals, whose DOM-deferral trick keys off DOM markers that the WebWorker lib
  does not provide. The worker needs no Node types at all, so removing them is
  free and it removes the whole conflict class.
- **`"exclude": ["src/sw.ts"]`** on the app program. `include: src/**/*.ts` would
  otherwise pull the worker back into the DOM program and reintroduce exactly the
  error this split exists to prevent.
- **`src/pwa/policy.ts` is compiled in both programs**, and therefore
  **everything `sw.ts` imports must typecheck under both libs** — meaning it must
  name neither a DOM type nor a WebWorker type. That is not an accident of the
  layout, it is why P5 Q47 made `SwRequestInfo` a plain struct rather than a
  `Request`. A task that adds a DOM type to `policy.ts` breaks the worker build,
  and the error will point at the wrong file; the rule is stated here so it does
  not have to be discovered there.
- **`tools/**/*.ts`** is added to the app program so `write-assetlinks.ts` is
  typechecked at all. Under Plan 3's `include` it was in no program, which means
  the one TypeScript file that runs in production containers was the one file
  `tsc` never saw.

Service worker behaviour:

- `install`: open `cfg.cacheName`, `addAll(cfg.precache)`, then **do not**
  `skipWaiting`.
- `activate`: delete every cache whose name starts with `tapkart-` and is not
  `cfg.cacheName`; `clients.claim()`.
- `fetch`: build an `SwRequestInfo`, call `routeRequest`, execute the action. No
  other branching.
- `message`: `{ type: 'SKIP_WAITING' }` calls `sw.skipWaiting()` — and nothing
  else sends that message except §8.5's update flow.

**The service worker never activates over a running race** (P5 Q25).
Auto-`skipWaiting` would swap the JS bundle under a live authority loop; the
update lands when the player is on the results or title screen, or on the next
cold load. *(This is also what makes a protocol version mismatch after a deploy a
routine event rather than an exotic one — old clients keep running old bundles,
which is why GAP-2's non-throwing decode wrapper is a Plan 2 requirement and not
a hypothetical.)*

### 8.5 Update and install, as pure reducers

```ts
// apps/web/src/pwa/update.ts                                          PURE
export interface UpdateState { waiting: boolean; applying: boolean; deferred: boolean }
export type UpdateEvent =
  | { kind: 'workerWaiting' }
  | { kind: 'raceStarted' }
  | { kind: 'raceEnded' }
  | { kind: 'userAccepted' }
  | { kind: 'userDismissed' }
export function createUpdateState(): UpdateState
/** Pure; never mutates `prev`. `applying` becomes true only when a worker is
 *  waiting, the user accepted, and no race is in progress. */
export function reduceUpdate(prev: UpdateState, ev: UpdateEvent): UpdateState

// apps/web/src/pwa/install.ts                                         PURE
export interface InstallState { available: boolean; installed: boolean; dismissedAtMs: number }
export type InstallEvent =
  | { kind: 'promptAvailable' }
  | { kind: 'promptShown' }
  | { kind: 'dismissed'; nowMs: number }
  | { kind: 'installed' }
export const INSTALL_DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
export function createInstallState(): InstallState
export function reduceInstall(prev: InstallState, ev: InstallEvent): InstallState
```

`beforeinstallprompt` capture, `prompt()` and `appinstalled` live in
`apps/web/src/main.ts` (adapter). iOS has no `beforeinstallprompt` at all;
`available` simply stays false there and no instructional UI ships in v1.

### 8.6 Offline is a requirement, and it gates the build (F-P5-26)

*"It is what makes this a PWA rather than a website, and the game is fully
playable solo against bots with zero server involvement — the offline story here
is unusually complete, so shipping it as 'nice-to-have' would waste something
already true."*

Gated ⇒ the precache list is **load-bearing**: §12.3's offline spec fails CI
rather than shipping a broken offline path silently. The precache list must
therefore contain everything a solo race needs — the shell, the JS and CSS
chunks, the six bundled tracks (which are inside the JS bundle, per Plan 3 §3a.1's
static imports, so they need no separate entry), the icons, and the manifest.

### 8.7 Build tooling

```js
// apps/web/tools/precache.mjs
export function buildPrecacheList(viteManifest, extras)  // -> sorted absolute paths
export function precacheVersion(list)                    // -> short stable hash of the list

// apps/web/tools/png.mjs
export function encodePng(width, height, rgba)           // -> Uint8Array, zlib via node:zlib
export function drawIconRgba(size, palette)              // -> Uint8Array, deterministic
```

These are `.mjs`, not `.ts`, so vitest can import them with no loader and `tsc`
can ignore them: build tooling is not shipped code. `tools/write-assetlinks.ts`
is the exception — it imports `@tapkart/invite` for real (§11.3) and is therefore
TypeScript, in the app's tsconfig (§8.4), and bundled by `esbuild` in the Docker
build stage. `esbuild` is a declared **root devDependency** (P5 Q30): Plan 3's
content gate already invokes it, declaring a binary you execute is correct, and
relying on a transitive Vite dependency is how a major bump breaks the deploy.

`tools/build-sw.mjs` runs after the main Vite build, reads
`dist/.vite/manifest.json`, computes the precache list and version, and invokes a
second Vite build for `src/sw.ts` with `define: { __PRECACHE__, __SW_VERSION__ }`
and `emptyOutDir: false`, emitting **`dist/sw.js`** — unhashed, at the scope root,
because a service worker's scope is its own path. `apps/web/vite.config.ts` gains
`build.manifest = true` for the first half of that to exist.

---

## 9. The Web Audio backend

### 9.1 Where it lives

R39, in its own words: *"Plan 5 may add files under `packages/render/src/audio/`
— the Web Audio implementation of §4.9's `AudioBackend` — and may add the barrel
lines that export them."* So the draft's `src/audio-graph.ts` + `src/web/audio.ts`
are **replaced** by:

- `packages/render/src/audio/graph.ts` — **PURE**, re-exported from the barrel.
- `packages/render/src/audio/web.ts` — **ADAPTER**, *not* in the barrel, because
  it names `AudioContext` and Plan 3 §8.2's rule is that no adapter reaches the
  headless barrel.

```jsonc
// packages/render/package.json
"exports": {
  ".": "./src/index.ts",
  "./three": "./src/three/renderer.ts",
  "./web-audio": "./src/audio/web.ts"
}
```

mirroring exactly what Plan 3 did for `"./three"`. The subpath is
**`./web-audio`**, not `./audio`: `packages/render/src/audio.ts` already exists
(Plan 3 §4.9, the pure model and the seam), and a subpath export named `./audio`
that resolves to the *adapter* while the barrel exports the *model* is a name two
readers will read two ways.

**`packages/render/src/audio/index.ts` must not exist.** Under `moduleResolution:
"Bundler"` a bare `./audio` would then be ambiguous between the Plan 3 file and
the Plan 5 directory. Imports inside `render` are `./audio/graph` and
`./audio/web`, always.

### 9.2 Signatures

```ts
// packages/render/src/audio/graph.ts                                  PURE
export type AudioOpKind = 'setEngine' | 'setSkid' | 'setMaster' | 'oneShot' | 'silence'

export interface AudioOp {
  kind: AudioOpKind
  cue: AudioCueKind | 'none'
  freqHz: number
  gain: number
  pan: number          // -1..1
  durationMs: number
}
export interface AudioOpList { ops: AudioOp[]; count: number }

export interface OneShotSpec {
  waveform: 'sine' | 'square' | 'sawtooth' | 'triangle' | 'noise'
  startFreqHz: number
  endFreqHz: number
  durationMs: number
  peakGain: number
  attackMs: number
  releaseMs: number
  filterHz: number
}

/** One entry per AudioCueKind — TOTAL, so no lookup can miss. The whole sound
 *  design of the game, as data.
 *
 *  'engine' and 'skid' have entries with peakGain 0 and are never emitted as
 *  one-shots: they are the two CONTINUOUS voices (§9.3) and the map is total
 *  only so that a cue kind can never index past the end of it.
 *
 *  F-P5-28: authored by the implementing task with reasoned defaults and tuned
 *  by the owner on a device. NOT delegated — the track palettes were a good
 *  delegation because the gate could check them; sound-design numbers have no
 *  schema-level notion of correct, so a model's output cannot be gated
 *  meaningfully and delegation would produce confident garbage with a green
 *  check beside it. */
export const ONE_SHOT_SPECS: Readonly<Record<AudioCueKind, OneShotSpec>>

export const MAX_AUDIO_OPS = 32
export const MAX_ONE_SHOTS_PER_FRAME = 4
export const ONE_SHOT_VOICE_LIMIT = 12
export const ENGINE_SMOOTHING_MS = 60

export function createAudioOpList(): AudioOpList

/** SOLE WRITER of AudioOpList. Allocation-free: `out.ops` is preallocated to
 *  MAX_AUDIO_OPS and `out.count` says how many are live, exactly as
 *  WireSnapshot.entityCount does. `cfg.enabled === false` emits one 'silence'
 *  op and nothing else. Takes Plan 3's AudioConfig — there is no second config
 *  type (R38). */
export function planAudio(model: AudioModel, cfg: Readonly<AudioConfig>, out: AudioOpList): void
```

```ts
// packages/render/src/audio/web.ts                                    ADAPTER
/** `typeof AudioContext !== 'undefined'`. Nothing else. */
export function isWebAudioAvailable(): boolean

/** Takes an ALREADY-CONSTRUCTED, already-resumed AudioContext. It does not
 *  construct one, because construction must happen inside a user gesture and
 *  this function is called from composition, not from an event handler.
 *
 *  Returns a plain AudioBackend — R38 put setConfig IN the seam, so there is no
 *  widened type and `apps/web` holds exactly what `game` holds. */
export function createWebAudioBackend(context: AudioContext, initial: Readonly<AudioConfig>): AudioBackend
```

`initial` is explicit rather than defaulted so the backend never has a state
nobody chose. The shell then calls `setConfig` on every `Settings` change and once
at startup, which Plan 3's shipped shell already does (§2.1).

### 9.3 The voice budget, and the per-frame budget

Plan 3 ruling Q26, binding: *"local kart engine voice only, plus one-shots for
items, impacts and lap crossings. Eight oscillators for eight engines is a mobile
battery problem and a mix nobody can hear through."* The graph is:

- **one** engine voice: sawtooth oscillator → lowpass → gain → panner → master.
  Frequency and gain follow `AudioModel.engineFreqHz`/`engineGain` via
  `setTargetAtTime` with `ENGINE_SMOOTHING_MS`; **never** `setValueAtTime`, which
  zippers audibly.
- **one** skid voice: a looping noise buffer, generated **once, at construction**
  → bandpass → gain → master.
- **at most `MAX_ONE_SHOTS_PER_FRAME`** transient voices created per frame, each
  from its `OneShotSpec`, disconnected on `ended`, with at most
  `ONE_SHOT_VOICE_LIMIT` alive at once.
- **one** master gain → destination.

**The per-frame budget, because `apply` runs on every rendered frame (§2.2):**
`apply` allocates nothing when `model.cueCount === 0`, constructs no node, and
writes a parameter only when the target value differs from the last one written.
A backend that re-schedules three `setTargetAtTime` calls 120 times a second on an
idle title screen is a battery problem the profiler will blame on the renderer.

`close()` stops both continuous voices, disconnects everything, and does **not**
close the `AudioContext` — the context belongs to `apps/web` (§13).

### 9.4 The gesture gate

```ts
// apps/web/src/platform/audio.ts                                      ADAPTER
export interface AudioGate { context: AudioContext | null; dispose(): void }
/** Attaches a one-shot pointerdown/keydown listener, constructs and resumes the
 *  AudioContext inside that gesture, then calls back. The ONLY place in the
 *  repository that constructs an AudioContext. */
export function installAudioGate(onReady: (ctx: AudioContext) => void): AudioGate
```

Every mobile browser refuses to start an `AudioContext` outside a user gesture,
and a context created at load sits `suspended` forever with no error. Until the
gate fires, `apps/web` passes `nullAudioBackend` — which is Plan 3's shipped
default and needs no new branch anywhere.

---

## 10. `apps/web` — the platform adapters and the origin rule

### 10.1 `src/platform/env.ts` — ADAPTER

```ts
/** The deployed origin baked in at build time, trailing slash stripped, or ''
 *  when unset. Only the APK build sets it (§3.1); a browser build leaves it
 *  empty and nothing breaks. */
export const BUILD_ORIGIN: string        // import.meta.env.VITE_TAPKART_ORIGIN ?? ''

/** True inside the Capacitor WebView. One expression, one global read; this is
 *  the single permitted platform check in the whole app. */
export const IS_NATIVE: boolean

/** chooseOrigin(IS_NATIVE, BUILD_ORIGIN, location.origin). Every invite URI and
 *  every QR payload in the app comes from here. */
export function appOrigin(): string
```

`apps/web` already has `src/vite-env.d.ts`-equivalent coverage through Plan 3's
Vite setup; `import.meta.env` typechecks under the app program.

### 10.2 `src/platform/nfc.ts` — ADAPTER

```ts
/** The Capacitor bridge's shape, declared here rather than imported, so the
 *  plugin's TS surface and the Kotlin @PluginMethod list are compared by review
 *  against one written-down thing. Mirrors §7.4 exactly. */
export interface TapkartNfcPluginBridge {
  isSupported(): Promise<NfcSupport>
  startAdvertising(options: { uri: string }): Promise<void>
  stopAdvertising(): Promise<void>
  startReader(): Promise<void>
  stopReader(): Promise<void>
  getPendingInvite(): Promise<{ uri: string | null }>
  addListener(
    eventName: 'inviteUri',
    cb: (ev: { uri: string; source: InviteSource }) => void,
  ): Promise<{ remove(): Promise<void> }>
}

/** Returns the Capacitor-backed NfcHost when IS_NATIVE, `nullNfcHost` otherwise.
 *  The only `registerPlugin` call in the repository. Contains no decisions
 *  beyond that one platform check. */
export function capacitorNfcHost(): NfcHost
```

### 10.3 `src/pwa/origin.ts` — PURE, and it is where C-3 lives

```ts
/** Trailing slash removed; '' stays ''. */
export function stripTrailingSlash(origin: string): string

/** C-3, as a function.
 *
 *  - Not native  -> `locationOrigin`. The running web app builds its own invite
 *    URIs from where it is actually served, so a self-hoster on any domain works
 *    with NO REBUILD and the origin is correct by construction.
 *  - Native      -> `buildOrigin`. Inside the Capacitor WebView `location.origin`
 *    is the WebView's local scheme, NOT the deployed origin, so using it there
 *    would emit an invite URI no guest can open — the silent failure C-3 exists
 *    to prevent. Per F-P5-11 the APK is a domain-specific build anyway, and its
 *    baked origin is the SAME variable that produced its intent filter, which is
 *    exactly what keeps §3's values 1 and 2 agreeing.
 *
 *  THROWS when `isNative` and `buildOrigin` is empty. An APK built with no
 *  TAPKART_ORIGIN would otherwise advertise an invite that resolves nowhere, and
 *  it would do it silently on the one device that has HCE. Failing at module
 *  load, in a build CI runs, is the only loud moment available. */
export function chooseOrigin(isNative: boolean, buildOrigin: string, locationOrigin: string): string
```

Putting the choice here rather than inside `env.ts` is §0a's rule applied to the
sharpest branch in the plan: **an adapter contains no decisions**, so the one
conditional that decides what every invite URI in the product says lives in a
pure module with a unit test for each of its four cases (browser, native-with-origin,
native-without-origin, trailing slash).

---

## 11. Deploy

### 11.1 Image

- Registry **`ghcr.io/atvriders/tapkart`**, multi-arch **`linux/amd64,linux/arm64`**,
  **public, always** — this repo's standing rule; a first publish that lands
  private is a bug to fix, not a state to accept.
- Multi-stage `Dockerfile` at the repo root:
  - **`build` stage** on `node:20-alpine`: `npm ci` at the root (workspaces);
    `npm run build -w apps/web` (Vite + `tools/build-sw.mjs` + icons);
    `npm run build -w @tapkart/server` (C-5's esbuild bundle — **Plan 4 owns the
    script**, this stage only runs it); and
    `npx esbuild apps/web/tools/write-assetlinks.ts --bundle --platform=node --format=esm --outfile=/out/write-assetlinks.mjs`.
  - **`runtime` stage** on `node:20-alpine`: `packages/server/dist/main.mjs` at
    `/app/main.mjs`, `apps/web/dist` at `/app/web` (with an empty
    `/app/web/.well-known/` owned by the `node` user, because that is where
    §11.3 writes), and the tool at `/app/tools/write-assetlinks.mjs`, plus
    `docker/entrypoint.sh`. Runs as **non-root `node`**. `EXPOSE 3031`.
    `HEALTHCHECK` hits `/healthz` on `127.0.0.1`.

  The bundle is one file with no `node_modules` beside it, which is the point of
  C-5: *the fastest start, and it keeps the repo's "every `exports` points at
  `.ts`" arrangement intact everywhere else.*
- `compose.yaml` (Plan 4 §1a's name): one service, `image: ghcr.io/atvriders/tapkart:latest`,
  `ports: ["3031:3031"]`, `restart: unless-stopped`, and the §11.2 variables,
  each with a placeholder value and a comment saying the owner substitutes it.

`latest` means **a release** (F-P5-33): the README's compose file must not mean
"whatever merged five minutes ago", because that makes "just run the compose
file" an unpredictable instruction. Self-hosters who want head use `edge`,
explicitly (§12.1).

### 11.2 Environment — one schema, three consumers, and a test between them

C-6: *"`server/src/env.ts` declares every variable, its type, its default and
whether it is required. The Dockerfile, the compose file and the README table are
checked against it by a test that fails when they drift. A variable that exists
in one and not the other is a build failure, not a 3 a.m. discovery."*

The deployment's variables are exactly `ENV_SCHEMA ∪ ASSETLINKS_ENV_VARS`:

| Variable | Set in the image | In `compose.yaml` | Note |
|---|---|---|---|
| `PORT` | — (default 3031) | yes | spec §9 |
| `BIND_HOST` | `0.0.0.0` | — | never a real hostname |
| `STATIC_ROOT` | `/app/web` | — | absolute, because the image is not a checkout. **`<STATIC_ROOT>/.well-known/` is the one well-known directory** — §11.3 writes it, Plan 4 serves it, and there is no second variable to disagree with |
| `MAX_ROOMS`, `MAX_PEERS_PER_ROOM`, `ROOM_IDLE_MS`, `JOIN_RATE_WINDOW_MS`, `JOIN_RATE_MAX`, `SHADOW_ENABLED` | — | commented out, with the schema's defaults | |
| `ICE_SERVERS` | — | commented out, with its default shown | F-P4-16's disclosure, §11.5 |
| `TAPKART_ANDROID_PACKAGE` | — | yes, placeholder | must equal the APK's `applicationId`; read by §11.3's generator, never by the server |
| `TAPKART_SHA256_FINGERPRINTS` | — | yes, placeholder | comma-separated; the `DE:AD:BE:EF…` placeholder in the file |

Every row of the first block is `ENV_SCHEMA`'s (Plan 4's); the last two are
`ASSETLINKS_ENV_VARS`' (§4.7). §11.4 asserts the union covers the Dockerfile and
the compose file exactly.

**`TAPKART_ORIGIN` is not here.** C-3 makes it a build-time variable for the APK
and nothing else: the server answers with paths, and `assetlinks.json` contains
no origin. The Plan 5 draft's compose entry for it is deleted.

`TRACKS_DIR` and `WELL_KNOWN_DIR` are also gone, both deleted by Plan 4: R46
makes `@tapkart/content` export parsed tracks via static imports *specifically so
a non-Vite Node/esbuild toolchain can consume them*, so the server reads no track
files from disk; and C-2 derives the well-known directory from `STATIC_ROOT`, so
the generator and the handler cannot name different places. Both deletions remove
a variable Plan 5's draft compose file set.

### 11.3 `assetlinks.json` is generated at container start, never committed (C-2)

`docker/entrypoint.sh` runs `node /app/tools/write-assetlinks.mjs` and then
`exec`s the server.

```ts
// apps/web/tools/write-assetlinks.ts
/** `<staticRoot>/.well-known/assetlinks.json`. Derived from STATIC_ROOT, which
 *  is the SAME variable Plan 4's static handler derives its well-known directory
 *  from (C-2) — so the generator and the handler cannot name different places,
 *  which is exactly what the two drafts did. */
export function assetLinksTargetPath(staticRoot: string): string

/** Reads TAPKART_ANDROID_PACKAGE, TAPKART_SHA256_FINGERPRINTS and STATIC_ROOT,
 *  builds the statement with buildAssetLinks(), validates it with
 *  validateAssetLinks(), and writes assetLinksTargetPath(STATIC_ROOT).
 *
 *  - both TAPKART_* unset -> writes nothing, logs one line, exit 0. A
 *                            self-hoster with no APK gets a working server.
 *  - set and malformed    -> logs the problems from validateAssetLinks, exit 1.
 *                            A misconfigured fingerprint fails loudly instead of
 *                            serving a valid-looking statement that signs nothing.
 *  - STATIC_ROOT unset    -> throws naming the variable. It has NO default here,
 *                            deliberately: ENV_SCHEMA's default is the relative
 *                            'apps/web/dist', which is a checkout path and wrong
 *                            inside the image, so a silent default would write a
 *                            correct file into a directory nothing serves.
 *
 *  Returns the list of problems, so a test can call it directly. */
export function writeAssetLinks(env: Record<string, string | undefined>): string[]
```

It imports `@tapkart/invite` — the real shipped validator, not a reimplementation
— per the standing rule from Plan 3 ruling Q2 (*"a gate that reimplements
validation tests the gate"*).

**Plan 4 serves it**, with no redirect, treating `/.well-known/*` as a real route
(C-2). **Plan 5 asserts the content**: that the generated statement is
well-formed, that the fingerprint parses, and — in the container test, §12.2 —
that the bytes actually come back over HTTP with the right content type and no
3xx.

The alternative, committing the file, is forbidden by §1; committing it with
*placeholder* values is worse than either, because it produces a deployment that
serves a **valid-looking** `assetlinks.json` naming a fingerprint that signs
nothing — spec §2's silent-failure mode with a false trail of evidence beside it.

### 11.4 `apps/web/test/deploy-env.test.ts` — C-6's drift test

The second and last test that reads the repository (§1). It imports `ENV_SCHEMA`
from `@tapkart/server` and `ASSETLINKS_ENV_VARS` from `@tapkart/invite`, parses
`Dockerfile` and `compose.yaml`, and asserts:

1. Every `ENV` line in the Dockerfile names a variable in `ENV_SCHEMA ∪
   ASSETLINKS_ENV_VARS`.
2. Every variable in the compose file's `environment:` block — **including the
   commented-out rows**, which is the half that rots — names a variable in the
   union.
3. Every commented-out row's value equals that variable's `defaultValue`, so the
   compose file cannot document a default the server does not have.
4. Every **required** variable in the union appears uncommented in the compose
   file.

**The README grows no fourth copy of the table.** Plan 4 ships
`docs/server-env.md` from `formatEnvTable()` and asserts it; Plan 5's README
links to it (§11.7). Plan 4 §16.2 left that choice open and named this as its
assumption; taking it keeps the number of places the variable list is written at
**two**, which is the whole point of C-6.

`apps/web` gains `@tapkart/server` as a **devDependency** for this, and for
nothing else. It is a test-only edge — the same test-only cross-boundary reach
Plan 2 §6 and Plan 3 ruling Q34 already permit for fixtures — and `apps/web/src`
never imports it, which P4 Q50's import-allowlist test enforces by exempting
`test/`.

### 11.5 The STUN default, disclosed (F-P5-16)

`ICE_SERVERS` defaults to `stun:stun.l.google.com:19302`, and the README says so
in the environment table **and** in a sentence naming it as a third-party
endpoint contacted at connection time. *An empty default means WebRTC succeeds
only on the same LAN, so essentially every real guest falls to the WebSocket relay
and the server carries the whole race — which discards the entire peer-to-peer
architecture. That is not a conservative default, it is a different product.
Disclosure is the answer to the privacy cost, not crippling the transport.*

The default and the disclosure paragraph both live on Plan 4's side —
`ENV_SCHEMA` and `docs/server-env.md` (Plan 4 §10.2). Plan 5's duty is that the
README **links to it and repeats the one sentence naming the third-party
endpoint**, so a self-hoster reading only the README still learns it, and that
`compose.yaml`'s commented `ICE_SERVERS` row carries the schema's default
verbatim — which §11.4 rule 3 asserts.

### 11.6 APK distribution

Spec §9: *"published as a GitHub Release asset, since the owner is responsible for
on-device NFC verification."* One `app-release.apk` per `v*` tag, uploaded to that
tag's Release. No Play Store, no App Bundle, no internal track.

### 11.7 `docs/owner-verification.md` and the README

Both are Plan 5 deliverables (P5 Q40). Spec §11 makes the README half mandatory —
*"Backed up on creation; documented in the repo README"*. The README gains:

- keystore generation, the exact `keytool` invocation with placeholder values,
  and **backup on the day of creation, in two places**;
- the self-host section: the compose file, a **link to `docs/server-env.md`**
  rather than a second env table (§11.4), and the `curl -I` no-redirect check
  (P5 Q38) — *the container test proves the container; the tunnel, the proxy and
  any trailing-slash normalisation are outside that proof and inside the
  owner's*;
- the STUN disclosure (§11.5);
- the statement that only someone shipping their **own APK** needs a
  domain-specific build (C-3), so a self-hoster does not go looking for a
  `TAPKART_ORIGIN` that does not apply to them.

---

## 12. CI/CD

### 12.1 Workflows

**`.github/workflows/ci.yml`** — on `push` and `pull_request`:

| Job | Runs |
|---|---|
| `web` | `npm ci`; `npm run typecheck` (**both** tsconfigs, §8.4); `npm test`; `npm run build -w apps/web`; the §12.2 static assertions over `dist/` |
| `android` | `setup-java` JDK **21** (spec §9); `setup-android` (SDK + licences); Gradle cache; `./gradlew :app:testDebugUnitTest` (§5.7's vectors, in Kotlin); `./gradlew :app:assembleDebug`; the §12.2 assertions over the **merged** manifest |
| `e2e` | Plan 4's Playwright lane (C-4), including §12.3's offline specs |
| `container` | build the image for the host arch only, run it, execute the §12.2 container assertions. **Gating, not informational** (P5 Q34) — it is the only thing that proves the served `assetlinks.json` exists with the right content type and no redirect, which is spec §2's silent-failure mode |
| `edge-image` | `if: push to master` — QEMU + Buildx + login, push `linux/amd64,linux/arm64` tagged **`edge`** and `sha-<short>` |

**`.github/workflows/release.yml`** — on `push` of a `v*` tag:

| Job | Runs |
|---|---|
| `image` | QEMU + Buildx + login (`GITHUB_TOKEN`, `packages: write`) → push `linux/amd64,linux/arm64` to `ghcr.io/atvriders/tapkart`, tagged **`latest`**, the version, and `sha-<short>` |
| `apk` | decode `ANDROID_KEYSTORE_BASE64` into `$RUNNER_TEMP`; `./gradlew :app:assembleRelease`; `apksigner verify --print-certs`; assert the printed SHA-256 equals the first entry of `vars.TAPKART_SHA256_FINGERPRINTS`; upload the APK to the Release |

**F-P5-33, stated as the rule it is:** `latest` moves on `v*` tags **only**;
`master` publishes `edge`. Every push that publishes tags the version and the
commit SHA (P5 Q34).

Secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
Variables: `TAPKART_ORIGIN`, `TAPKART_ANDROID_PACKAGE`,
`TAPKART_SHA256_FINGERPRINTS`. A fingerprint is a **variable, not a secret**
(P5 Q35): it is published to the world in `assetlinks.json` by design; §1 forbids
it in a repo *file*, and a variable is not a file.

Ecosystem facts this repo has already paid to learn, recorded so nobody
rediscovers them: Actions are enabled for the `Atvriders` org and GHCR packages
publish and default to public; a **forked** repo's first workflow run needs a
manual `workflow_dispatch` before push-triggered runs work; and a PR from a fork
has **no secrets**, which is why release signing is tag-only and PRs build debug.

### 12.2 The assertions CI actually makes — enumerated, because §14 depends on it

**Pure, in vitest:**

1. `processApdu` against **every line** of `t4t-exchange.tsv` — response bytes and
   `selected` compared exactly — and the runner fails if the file yields zero rows.
2. `buildNdefFile`/`parseNdefFile` against every line of `ndef-uri.tsv`,
   round-trip and exact bytes.
3. `CC_FILE` equals the 15 bytes of §5.3, byte for byte.
4. `readInvite` driven against `processApdu` through a synchronous `Transceive` —
   the reader and the tag, proven against each other with no radio — including the
   non-advertising case returning `null`.
5. `buildInviteUri`/`parseInviteUri` round-trip; every rejection case returns
   `null` rather than throwing; a URI with a query string or a fragment is
   rejected (P5 Q14).
6. `buildInviteUri` builds its path from `LOBBY_PATH_PREFIX` and its validation
   from `isValidRoomCode` — asserted by a test that constructs the expected string
   from the imported constants, so it fails when Plan 4 changes either (C-1, C-7).
7. `isValidFingerprint` accepts the §1 placeholder and rejects lowercase,
   31 bytes, 33 bytes, missing colons, and a SHA-1-length string.
8. `validateAssetLinks` returns `[]` for `buildAssetLinks(...)` output and names
   the field for each of: wrong relation, wrong namespace, absent package, empty
   fingerprint list, malformed fingerprint.
9. `routeRequest` over §8.3's table, every row, in order — including a
   `/.well-known/` navigation, which must be `networkOnly` and not `shellFallback`.
10. `planAudio`: `enabled: false` yields exactly one `silence` op; more cues than
    `MAX_ONE_SHOTS_PER_FRAME` yields exactly `MAX_ONE_SHOTS_PER_FRAME` one-shots;
    no `oneShot` op is ever emitted for kind `engine` or `skid`; every emitted
    `gain` is within `[0, 1]`; `count <= MAX_AUDIO_OPS`; a zero-cue model emits no
    `oneShot` op at all.
11. `chooseOrigin`'s four cases (§10.3), including the native-without-origin throw.
12. `buildQrMatrix`: `size === 4 * version + 17`; the three finder patterns are
    present at the three corners; §5.9's published tables match the computed ones;
    the published symbol reproduces module for module; and §5.9 layer 3's capacity
    arithmetic holds with every term imported.
13. `encodePng` emits a valid signature, IHDR and CRC-correct chunks at the
    manifest's declared sizes.
14. §1's no-secrets grep over the tracked file list.
15. §11.4's environment drift test.

**In Kotlin, on the JVM, no device:**

16. `T4tTag.process` against the **same** `t4t-exchange.tsv`, same failure on an
    empty file.
17. `NdefUri` against the **same** `ndef-uri.tsv`.
18. `InviteIntent.uriFrom` resolves `ACTION_VIEW` and `ACTION_NDEF_DISCOVERED`
    identically over a table including `null`, `''` and a blank string (F-P5-16).

**Structural, over declaration files (the merged manifest, not the source one):**

19. Exactly one `<intent-filter>` carries `android:autoVerify="true"`, and it has
    `ACTION_VIEW`, `DEFAULT`, `BROWSABLE`, `scheme="https"`, a non-empty host, and
    a `pathPrefix` **equal to `LOBBY_PATH_PREFIX`**.
20. Exactly one `<intent-filter>` carries `NDEF_DISCOVERED`, with the same scheme,
    host and `pathPrefix`, and **without** `autoVerify`.
21. The host in both filters equals `originHost(TAPKART_ORIGIN)` for the build
    (§3, values 1 and 2 agree).
22. `TapkartHceService` is declared with
    `android:permission="android.permission.BIND_NFC_SERVICE"`,
    `android:exported="true"`, the `HOST_APDU_SERVICE` action, and the
    `host_apdu_service` meta-data pointing at `@xml/apduservice`.
23. `apduservice.xml` contains exactly one `aid-filter`, and it is
    `D2760000850101`, with `requireDeviceUnlock="true"`.
24. Every component with an intent filter has an explicit `android:exported`.
25. `compileSdk == targetSdk`, `targetSdk >= ` the Android 16 API level recorded
    in §6.6, and `minSdk >= 26` — **relations, not literals** (F-P5-31).
26. `manifest.webmanifest` parses; `name`, `start_url`, `scope`, `display`,
    `orientation: "landscape"` and `icons` are present; every icon file exists in
    `dist/` at its declared size.
27. `dist/sw.js` exists at the root of `dist/`, unhashed.

**By running the artifact:**

28. `apksigner verify --print-certs` on the release APK prints a SHA-256 equal to
    the first entry of `TAPKART_SHA256_FINGERPRINTS` (§3, value 5).
29. The `applicationId` inside the built APK equals `TAPKART_ANDROID_PACKAGE`
    (§3, value 4).
30. The built container, started **with both `TAPKART_*` variables set**, comes
    up at all — which is also the test for §2.5's hazard, since Plan 4's
    `parseConfig` throws on an unknown `TAPKART_*` variable — and then answers
    `GET /.well-known/assetlinks.json` with **HTTP 200**,
    `Content-Type: application/json`, **no redirect** (the request is made without
    following redirects and any 3xx fails the job), and a body that
    `validateAssetLinks` accepts.
31. The same container, started with **no** `TAPKART_*` variables, starts anyway
    and answers `/healthz` — P5 Q37's self-hoster-with-no-APK path, proven rather
    than assumed.
32. `docker buildx imagetools inspect` on the pushed tag lists both platforms.

### 12.3 What Playwright adds

The harness is **Plan 4's** (C-4): Plan 4 creates `playwright.config.ts`
(`testDir: 'e2e'`), the `e2e/` directory, the first spec and the `test:e2e`
script, because spec §8's E2E row needs the server, the lobby and the room code,
and all three are Plan 4's. **Plan 5 owns the CI job** that runs it (Plan 4 §1a)
and adds two specs under `e2e/`:

33. Load the app, wait for the service worker to control the page, go offline
    (`context.setOffline(true)`), reload, and assert the app shell still renders
    and a **solo race starts and runs**. This is a real proof that the offline
    path works, in a real browser, with a real service worker — and F-P5-26 makes
    it **gating**.
34. With the worker active and the network up, request
    `/.well-known/assetlinks.json` and assert it is served from the network and is
    in no cache — `routeRequest`'s `networkOnly` rule, end to end.

---

## 13. Sole-writer rules

| Thing | Sole writer | Note |
|---|---|---|
| `TagState.ndefFile` | `setNdefUri` | never assigned directly; `createTagState` initialises it to the empty file |
| `TagState.selected` | `processApdu` and `resetTag` | nothing else, in either language |
| `LobbyAdvert.uri` | `TapkartNfcPlugin` | `TapkartHceService` reads it and never writes it; nothing persists it (§6.4 rule 3) |
| `FLAG_KEEP_SCREEN_ON` | `TapkartNfcPlugin.startAdvertising`/`stopAdvertising` | paired; a leak here is a flat battery |
| The preferred HCE service | the same two methods | `setPreferredService`/`unsetPreferredService`, paired |
| The `Cache` storage | the service worker's `install`/`activate`/`fetch` handlers | page code never opens `caches` |
| `AudioOpList` | `planAudio` | `createAudioOpList` allocates it once and nothing else assigns `count` |
| The `AudioContext` | `installAudioGate` | `createWebAudioBackend` receives one and never constructs or closes one |
| `<STATIC_ROOT>/.well-known/assetlinks.json` | `writeAssetLinks`, at container start | never committed, never edited by hand, never written by the server |
| `manifestPlaceholders["tapkartHost"]` | `apps/android/app/build.gradle.kts`, from `tapkartOrigin` | no other file names a host |
| The signing keystore | the `release` signing config | read by nothing else, in no other job |
| `AudioModel` | Plan 3's `buildAudioModel` | Plan 5 reads it and never writes it — including never clearing `cues` itself |
| The `RaceView` pair and the swap | Plan 3's `RaceSession`/`ViewBuilder` | Plan 5 never calls `swapViews`, never builds a view, and never reorders the frame loop (§2.2) |
| `LOBBY_PATH_PREFIX`, `ROOM_CODE_ALPHABET`, `ROOM_CODE_LENGTH` | `@tapkart/protocol` | Plan 5 imports all three and spells out none of them |

---

## 14. What CI cannot verify — stated plainly, because the spec sets that standard

Spec §8's *What CI cannot verify* names two things and says both are
owner-verified. Spec §2's *Known limits (stated, not hidden)* names four more.
This is the complete list for Plan 5, and it is written to be *read against*
§12.2: everything mechanical is there, everything below is not.

| Cannot be verified in CI | Why | The nearest thing CI does prove (§12.2) |
|---|---|---|
| **The NFC tap** | HCE requires two physical devices in antenna contact | 1, 4, 16 — both implementations answer every APDU in the table identically, including the error cases |
| **App Links verification** | Android's verifier runs on-device, against the real domain, for the installed certificate | 19, 21, 28, 29, 30 — every input to the verifier is correct and self-consistent |
| **That the deployed origin serves our container** | The Cloudflare Tunnel config is the owner's and its hostname is not in the repo | 30 — the container serves it correctly on loopback |
| **That the second entry point fires on a real Android 15 phone** | The OS decides which intent an NDEF tag raises | 18, 20 — the filter is declared and both actions resolve to one URI |
| **That the host's screen stays on, and antenna alignment** | Physical | nothing. §6.4 rules 1 and 3 are code review only |
| **Android 17+ notification-tap flow** | OS behaviour on an OS version no runner has | nothing |
| **iPhone background reading of an emulated tag** | Spec §2: *"good but not universal across models and OS versions"* | nothing |
| **That audio sounds like an engine** | Judgement, on a speaker | 10 — the op list is exactly right |
| **That the QR scans** | A camera, a screen, and lighting | 12 — the matrix matches a published symbol and the published tables |
| **That the install prompt appears** | Chrome's engagement heuristics | 26 — the manifest is installable-shaped |
| **How the game feels on a phone** | Spec §8 | nothing |

**This contract does not claim CI proves the NFC tap works. It claims CI proves
the bytes are right.** Those are different sentences and the difference is the
whole point of §5.

### 14.1 The owner verification checklist

Plan 5 ships `docs/owner-verification.md` with a numbered, on-device script. The
list is fixed here so a task cannot quietly shorten it:

1. Install the **release** APK (not debug) on the host phone. Confirm App Links
   verification: `adb shell pm get-app-links <package>` reports `verified` for the
   deployed host.
2. `curl -I https://<host>/.well-known/assetlinks.json` through the real tunnel:
   200, `application/json`, **no** 3xx (P5 Q38). The container test proves the
   container; the tunnel and the proxy are outside that proof.
3. Host a lobby. Confirm the QR and the room code are on screen **at the same
   time** as the tap prompt (spec §2's *"always displayed alongside"*).
4. Tap a **guest without the app**. Confirm the browser opens the lobby
   (Android ≤ 16) or that a notification appears and opens it (Android 17+).
5. Tap a **guest with the app, foregrounded**. Confirm the join happens in-app
   with no browser.
6. Tap a **guest with the app, backgrounded**. Confirm App Links routes into the
   app, not the browser.
7. Tap a **guest with the app on Android 15 or earlier**, if one is available —
   this is the row F-P5-16's second filter exists for.
8. Cold-start case: with the app **not running**, tap. Confirm the app launches
   *into the lobby*, not the title screen — this is what `getPendingInvite`
   (§7.4) exists for and the only place it can be checked.
9. Tap with the host's screen **locked**. Confirm nothing happens — this is the
   documented limit, and confirming it is confirming the documentation.
10. Tap with the **host app backgrounded**. Confirm **nothing happens**. This is
    F-P5-45's deliberate behaviour, not a defect: *a tap that fails the same way
    every time is debuggable and explainable; one that works only while the screen
    happens to be on is neither.*
11. Tap with an **iPhone XS or newer**. Record the model and OS version alongside
    the result, because spec §2 says this one is not universal.
12. Scan the QR from a second phone at arm's length, and type the room code by
    hand. Both are the "nobody is ever blocked" path and neither is CI-checkable.
13. Airplane-mode the phone, open the installed PWA, confirm it loads and a solo
    race runs.
14. Confirm the engine pitch tracks speed and that item, impact and lap sounds
    fire — the whole of §9, which CI proves only as an op list.
15. Confirm the keystore backup exists, **in two places**, before the first
    release tag is pushed.

---

## 15. Files Plan 5 creates, and the exact files it edits outside its own scope

### 15.1 Creates

Everything under `packages/invite/` (including `vectors/`), `apps/android/`,
`apps/web/src/pwa/`, `apps/web/src/platform/`, `apps/web/src/sw.ts`,
`apps/web/tsconfig.sw.json`, `apps/web/tools/`,
`apps/web/public/manifest.webmanifest`, `apps/web/test/`,
`packages/render/src/audio/graph.ts`, `packages/render/src/audio/web.ts`,
`Dockerfile`, `docker/entrypoint.sh`, `compose.yaml`,
`.github/workflows/ci.yml`, `.github/workflows/release.yml`,
`docs/owner-verification.md`, and two Playwright specs under Plan 4's `e2e/`.

### 15.2 Edits, and this is the complete list

| File | Owner | Edit |
|---|---|---|
| `package.json` (root) | Plan 1 | add `esbuild` devDependency; add `build` and `e2e` scripts |
| `.gitignore` | Plan 1 | §1's list |
| `README.md` | Plan 1 | keystore generation and backup, self-host section, a link to Plan 4's `docs/server-env.md`, the STUN disclosure sentence (§11.7) |
| `packages/render/package.json` | Plan 3 | `exports["./web-audio"]` |
| `packages/render/src/index.ts` | Plan 3 | barrel re-exports `audio/graph` — **never** `audio/web` |
| `packages/game/package.json` | Plan 3 | dependency on `@tapkart/invite` (R39; P5 Q4 makes it unconditional) |
| `packages/game/src/shell.ts` | Plan 3 | `ShellOptions.nfc?: NfcHost` and `ShellOptions.origin?: string` (§2.3); the lobby's invite panel — tap prompt, QR and room code together |
| `apps/web/index.html` | Plan 3 | manifest link, `theme-color` meta |
| `apps/web/src/main.ts` | Plan 3 | SW registration, install/update wiring, the audio gate, `NfcHost` selection, `origin` |
| `apps/web/vite.config.ts` | Plan 3 | `build.manifest = true` |
| `apps/web/package.json` | Plan 3 | dependency on `@tapkart/invite`; **dev**Dependency on `@tapkart/server` (§11.4 only); `build` chains `tools/build-sw.mjs`; `typecheck` runs both tsconfigs |
| `apps/web/tsconfig.json` | Plan 3 | `include` gains `tools/**/*.ts`; `exclude` gains `src/sw.ts` (§8.4) |

**Two rows the draft had are gone:** the root `workspaces` glob and
`vitest.config.ts`'s `apps/*/test/**` include are **Plan 3's** edits (R36, R37),
already made. **Two rows the draft called conditional are unconditional:** the
`@tapkart/invite` dependency and the `ShellOptions` field, both licensed by name
in R39 and confirmed by P5 Q4.

**`packages/protocol` is not on this list.** C-1, C-7 and F-P4-34 land there —
`LOBBY_PATH_PREFIX`, `ROOM_CODE_ALPHABET`, `ROOM_CODE_LENGTH = 5`,
`normalizeRoomCode`, `isValidRoomCode` — but that is **Plan 4's** amendment.
Plan 5 imports them and edits nothing in `protocol`, `net` or `sim`. If Plan 5
appears to need a change in one of those three, the seam is in the wrong place.

### 15.3 What Plan 5 deliberately does not build

- **No iOS app.** Spec §1 puts it out of scope; spec §2's iPhone row is pure OS
  behaviour over a standards-compliant Type 4 tag, so there is nothing to write
  and nothing to assert (P5 Q44).
- **No Play Store listing, no App Bundle, no signing-key upload to Google.**
  Spec §9: a GitHub Release asset.
- **No Web NFC (`NDEFReader`).** Spec §2 rules it out in its first bullet: it
  reads and writes physical tags and has no peer-to-peer mode.
- **No Android Application Record** (§7.5).
- **No push notifications, no analytics, no crash reporting, no telemetry.**
- **No background sync and no offline multiplayer.** Offline means the installed
  app opens and a solo race runs against bots; a lobby needs a server.
- **No TURN/coturn.** Spec §3: STUN only, with the server-relay fallback, and
  that is Plan 4's.
- **No second `AudioBackend` implementation, no widened backend type, and no new
  `AudioModel` field.** R38 put `setConfig` in the seam precisely so that none of
  those is needed.
- **No changes to `sim`, `protocol` or `net`.**

---

## 16. Exported-symbol census

| Module | Count |
|---|---|
| `invite/hex` | 2 |
| `invite/uri` | 6 |
| `invite/invite` | 5 |
| `invite/t4t` | 14 |
| `invite/reader` | 7 |
| `invite/host` | 4 |
| `invite/applinks` | 10 |
| `invite/qr-tables` | 6 |
| `invite/qr` | 6 |
| **`packages/invite` subtotal** | **60** |
| `render/audio/graph` | 11 |
| `render/audio/web` | 2 |
| **`packages/render` additions subtotal** | **13** |
| `web/pwa/policy` | 7 |
| `web/pwa/update` | 4 |
| `web/pwa/install` | 5 |
| `web/pwa/origin` | 2 |
| `web/platform/env` | 3 |
| `web/platform/nfc` | 2 |
| `web/platform/audio` | 2 |
| `web/src/sw.ts` | 0 (a worker entry exports nothing) |
| `web/tools/precache` | 2 |
| `web/tools/png` | 2 |
| `web/tools/write-assetlinks` | 2 |
| **`apps/web` subtotal** | **31** |
| Kotlin `nfc/Hex` | 3 |
| Kotlin `nfc/NdefUri` | 5 |
| Kotlin `nfc/T4tTag` | 10 |
| Kotlin `nfc/InviteIntent` | 4 |
| Kotlin `nfc/LobbyAdvert` | 2 |
| Kotlin `nfc/TapkartHceService` | 3 |
| Kotlin `nfc/InviteReader` | 2 |
| Kotlin `TapkartNfcPlugin` | 10 |
| Kotlin `MainActivity` | 1 |
| **`apps/android` subtotal** | **40** |
| **Total** | **144** (104 TypeScript/JS, 40 Kotlin) |

Plus two optional fields added to Plan 3's `ShellOptions` (§2.3), which are not
new exported symbols; four fixture files (§5.8, §5.9); and the declaration files
of §6.2, §6.3, §8.2, §11 and §12.1, which export nothing and are checked
structurally.

---

## 17. Where each ruling landed, and the failures this contract is written to prevent

### 17.1 The rulings index

| Ruling | Lands in |
|---|---|
| **C-1** invite path is `/r/`, one constant in `protocol` | §1, §2.4, §3, §4.3, §6.2, §12.2 (6, 19, 20) |
| **C-2** Plan 5 generates `assetlinks.json`, Plan 4 serves it | §2.5 fact 3, §11.3, §12.2 (30, 31) |
| **C-3** web client reads `location.origin`; `TAPKART_ORIGIN` is build-time only | §3.1, §10.1, §10.3, §11.2 (the deleted variable) |
| **C-4** Plan 4 owns the Playwright harness | §2.5, §12.1, §12.3 |
| **C-5** the server is an esbuild bundle | §2.5 fact 1, §11.1 |
| **C-6** one env schema, compose asserted against it | §2.5 fact 2, §11.2, §11.4, §12.2 (15) |
| **C-7** `ROOM_CODE_ALPHABET` lives in `protocol` | §2.4, §4.0, §4.3 |
| **F-P4-34** five-character room codes | §1, §2.4, §5.7, §18.2 |
| **F-P4-16** public STUN default, documented | §11.2, §11.5, §11.7 |
| **F-P5-2** hand-written QR encoder, published vectors | §4.8, §5.9 |
| **F-P5-10** the APK bundles the web build | §6.1, §3.1 |
| **F-P5-11** `TAPKART_ORIGIN` build-time | §3, §3.1, §6.6 |
| **F-P5-16** add the `ACTION_NDEF_DISCOVERED` filter | §6.2, §7.3, §12.2 (18, 20), §14.1 item 7 |
| **F-P5-26** offline solo is a requirement and gates the build | §8.6, §12.3 (33) |
| **F-P5-28** `ONE_SHOT_SPECS` authored, not delegated | §9.2 |
| **F-P5-31** pin by rule, then record | §6.6, §12.2 (25) |
| **F-P5-33** `latest` on tags only, `master` → `edge` | §11.1, §12.1 |
| **F-P5-45** clear the advert on pause | §6.4 rule 3, §7.4, §14.1 item 10 |
| **GAP-5** `dom` and `webworker` cannot coexist | §8.4 |
| **P3-R38** `setConfig` is in the seam | §2.1 corrections 1 and 2, §9.2 |
| **P3-R39** what Plan 5 may add to Plan 3's packages | §2.3, §9.1, §15.2 |
| **P3-R40** landscape only | §8.2 |
| **P3-R49** the `RaceView` double buffer | §2.2, §13 |
| **P5 Q1, Q3, Q4, Q5, Q6, Q24, Q29** (invalidated) | §4.0, §9.1, §2.3, §4.3, §15.2, §8.2, §2.1 |
| **P5 Q9, Q12, Q14, Q15, Q17–Q23, Q25, Q27, Q30, Q32, Q34–Q38, Q40–Q44, Q46, Q47** (pre-ruled) | folded in at the point of use and cited inline |

### 17.2 The four highest-risk shared names, ranked by how many independent authors must agree

Plan 2's contract needed twelve amendments during authoring, each costing roughly
two blocking defects at audit. These are Plan 5's equivalents:

1. **The five values of §3, and the path prefix beside them.** Five files, four
   languages, one wrong host or one wrong prefix, and the result is an app that
   *works* — it just opens in the browser instead, silently, forever, on every
   Android 12 or newer device. No test fails. The mitigations are that all of them
   derive from `TAPKART_ORIGIN`, `LOBBY_PATH_PREFIX` and the keystore, and that
   §12.2's assertions 19, 20, 21, 28, 29 and 30 chain them together.
2. **`CC_FILE` and the status-word table (§5.3, §5.5).** Written twice, in two
   languages, by two authors. A single wrong byte in the CC makes every reader
   give up before it ever asks for the NDEF file, and the symptom is "the tap does
   nothing" — indistinguishable from bad antenna alignment. The shared fixture is
   the only thing standing between those two diagnoses.
3. **`resetTag` on `onDeactivated` (§5.6).** Omit it and the *first* tap of the
   day works perfectly, which is exactly the profile of a bug that ships.
4. **The pure/adapter seam in four new places** — `sw.ts`, `audio/web.ts`, the
   Kotlin services, and `platform/env.ts`. Plan 3 §8.2 established that one
   adapter import in a barrel breaks the entire headless suite with an error
   pointing at the wrong package; `three` was that risk, and `AudioContext`,
   `android.*` and `ServiceWorkerGlobalScope` are this plan's. §8.4's two-program
   split is the same defect in its typechecking form.

---

## 18. Unruled, needs the controller

Three items. Nothing here is a confirmation. Plan 4's contract locked in parallel
from the same rulings, so the three names this contract's draft had to pin
provisionally — the server bundle path, `ENV_SCHEMA`, and the Playwright spec
directory — are now **settled** and have moved into §2.5. What is left is this.

### 18.1 The container sets two `TAPKART_*` variables that Plan 4's parser throws on

Plan 4 §5.2: *"an unknown variable with the prefix `TAPKART_` throws, because
that prefix is ours and a typo in it is always a mistake."* Plan 5's `compose.yaml`
sets exactly two of them — `TAPKART_ANDROID_PACKAGE` and
`TAPKART_SHA256_FINGERPRINTS` — because §11.3's generator reads them from the
container environment at start-up. They are not typos and they are ours, but they
are unknown to `parseConfig`.

**As both contracts stand, the compose file C-6 exists to keep in step is the one
thing that stops the server booting.** Neither ruling reaches it: C-6 gave the
schema to Plan 4 and the container files to Plan 5, and nothing said what happens
to a variable the container needs and the server does not.

This contract assumes the resolution that keeps C-6's single source of truth
intact: **`ENV_SCHEMA` gains both, `required: false`, described as read by the
entrypoint rather than by the server.** That is a two-row change in a Plan 4 file.
The alternatives — exempting them in `parseConfig`, or having the entrypoint unset
them before `exec` — both create a second list of variable names, which is the
thing C-6 was decided to prevent.

§12.2's assertion 30 is written to fail loudly if this is not done: the container
is started **with both variables set**, so a server that refuses them fails CI
rather than the owner's deploy.

### 18.2 F-P4-34's five-character room code contradicts the spec

Spec §2 says **"a four-character room code"** in the *Known limits* paragraph
(*"QR and a four-character room code are always displayed alongside"*), and §5
says four elsewhere. **F-P4-34 rules five**, with reasoning (*"32⁵ ≈ 33.5 M, still
typeable, 32× the space of four"*), and the rulings document's amendment table
records it as landing in `@tapkart/protocol`.

Both this contract and Plan 4's apply **five**, because the ruling is explicit,
reasoned, repeated in the amendment table, and load-bearing for F-P4-34's other
half. But the rulings document's own instruction is *"where a ruling contradicts
the spec, say so and stop"*, and Plan 4 §16.3 says so too. **Spec §2 needs a
two-word amendment** before the first task is authored.

Everything downstream of it is wrong by exactly one character if the spec wins
instead: §1's `ABCDE` placeholder, the whole of §5.7's golden exchange (`NLEN`
becomes `00 1B`, the record 27 bytes, the file 29), §5.9's capacity arithmetic,
and the frozen NDEF byte sequence both languages replay.

### 18.3 Whether the README carries an environment table at all

Plan 4 §16.2 records this as unassigned: C-6 names *"the Dockerfile, the compose
file and the README table"*, Plan 4 owns none of those three, and Plan 4 ships
`docs/server-env.md` instead.

This contract takes Plan 4's stated assumption — **the README links to
`docs/server-env.md` and grows no table** — because that keeps the number of
places the variable list is written at two (`ENV_SCHEMA` and its generated file)
rather than four. §11.4 asserts the Dockerfile and the compose file only.

If the controller wants the README table that C-6's sentence literally names, it
is one more rule in §11.4 and one more thing to keep in step, and the drift test
already has the schema in hand to check it against.
