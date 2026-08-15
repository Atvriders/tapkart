# Tapkart Plan 5 — Locked Interface Contract (DRAFT, for ruling)

> **STATUS: DRAFT.** This is not yet binding. It is written for the controller to
> rule on and amend. §17 lists every place a guess was made; each item there is an
> amendment that would otherwise land mid-authoring, and Plan 2 measured each
> mid-authoring amendment at roughly **two blocking defects at audit**.
>
> Once ruled on, this becomes the **Global Constraints** section of the Plan 5
> implementation plan. Every task's requirements implicitly include everything
> here. No task may rename, re-sign, or add fields to anything below. A task
> needing something absent must define it in its own files and say so in its
> `Interfaces` block.

**Spec:** `docs/superpowers/specs/2026-08-13-tapkart-design.md` (amended 2026-08-14)
**Binding sections for this plan:** §2 (the NFC decision, in full, including
*Known limits*), §7 (Content — audio), §8's *What CI cannot verify*, §9 (Build and
deploy), §11 (Risks).
**Builds on:** Plan 1 (`@tapkart/sim`, merged `1f1f2c4`), Plan 2
(`@tapkart/protocol` + `@tapkart/net`, worktree `plan2-net`), Plan 3
(`@tapkart/render`, `@tapkart/game`, `apps/web` shell — in authoring), Plan 4
(`packages/server` — in authoring).
**Scope:** `packages/invite`, `apps/android`, the PWA and Web Audio halves of
`apps/web`, the Web Audio backend behind Plan 3's `AudioBackend` seam, and all
CI/CD and deploy. **Plan 5 of 5.**

Plan 3's rulings document (`2026-08-14-tapkart-plan3-rulings.md`) hands this plan
six things by name — **Q11**: "Not in Plan 3, deferred to Plan 5: PWA manifest,
service worker, offline caching, Dockerfile, CI publish" — and **Q26**: "Contract
§4.9's `AudioModel`/`AudioBackend` seam is kept and authored — a pure model with a
no-op backend — so **Plan 5 adds a Web Audio implementation and touches nothing
else**." Those six are the spine of this contract. Everything else here exists
because spec §2 or §9 requires it and no earlier plan claimed it.

---

## 0. Conventions that are decided, not negotiable

Plans 1–3's conventions carry forward unchanged and are **not** restated except
where Plan 5 adds to them. In particular: extensionless imports; `import type`
under `verbatimModuleSyntax`; bare specifiers across packages in `src`, never a
relative path into another package; vitest with `globals: false` and
`environment: 'node'`; TypeScript 5.9 `strict` with `noUnusedLocals`,
`noUnusedParameters`.

New for Plan 5:

| Convention | Value |
|---|---|
| Byte containers | `Uint8Array` everywhere in TS, `ByteArray` everywhere in Kotlin. Never `Buffer`, never `number[]`, never a hex string, in any signature |
| Hex in fixtures and logs | **uppercase, unseparated**, e.g. `00A4040007D276000085010100`. One spelling, so a string compare is a byte compare |
| APDU byte order | ISO 7816 is **big-endian** (offsets, file IDs, NLEN). This is the opposite of Plan 2's wire rule, and the opposition is load-bearing: `protocol` is little-endian because we chose it, `invite` is big-endian because ISO 7816-4 and the NFC Forum Type 4 Tag spec say so |
| NDEF byte order | big-endian (`NLEN`, payload lengths) |
| Nothing in `packages/invite` touches a clock, the DOM, the network, or a global | It is a pure codec package with zero dependencies, like `protocol`. `NfcHost` is an *interface* it declares, never an implementation it holds |
| Placeholders | See §1. **No real domain, LAN IP, hostname, host filesystem path, keystore, key, fingerprint or token appears in any file this plan writes.** No exceptions, no "just for the example" |
| Secrets reach the build as CI secrets/variables | never as repo files. A repo file may name the variable; it may never carry the value |
| Adapters contain no decisions | Plan 3 §0a's rule, extended to Kotlin and to the service worker. A conditional in an adapter is a contract violation, because it is a decision CI cannot see |
| Version pins | Every third-party version (Capacitor, AGP, Gradle, `esbuild`, the QR encoder, every GitHub Action) is pinned **once**, by the task named in §13, and every other task reads the pinned value. No task bumps a version to make its own step pass |

### 0a. The three-kind rule, extended to a second language

Plan 3 §0a says every `render` module is **pure** or **adapter** and the file says
which in its first line. Plan 5 has the same rule and one more kind, because it is
the first plan with non-TypeScript source and with files that are neither:

- **Pure** — a function of its arguments. No DOM, no `AudioContext`, no
  `android.*` import, no clock, no I/O. **Tested, and tested in both languages
  where both implement it.** Everything in `packages/invite`, `render/audio-graph.ts`,
  `apps/web/src/pwa/*`, and the Kotlin `nfc/Hex.kt`, `nfc/NdefUri.kt`, `nfc/T4tTag.kt`.
- **Adapter** — the thin layer handing plain data to a real device API. No
  branching on game state, no arithmetic beyond unit conversion.
  `apps/web/src/sw.ts`, `apps/web/src/platform/*`, `render/src/web/audio.ts`,
  and the Kotlin `TapkartHceService`, `TapkartNfcPlugin`, `InviteReader`,
  `MainActivity`.
- **Declaration** — XML, Gradle, Dockerfile, compose, workflow YAML. Not
  executable by vitest at all. These are checked by **structural assertions over
  the file itself** (§10.2) or by running the artifact they produce, never by
  being trusted.

The whole design of this plan is the fight to move as much as possible from the
third kind into the first. `processApdu` is the prize: the NFC tap cannot run in
CI, but the bytes the tap exchanges are a pure function over byte arrays, and
those *can* be proven — in both languages, against one shared fixture.

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
| Loopback in a healthcheck | `127.0.0.1` — permitted; it is not a host detail |
| Android `applicationId` | `io.github.atvriders.tapkart` (§17 Q12) |
| SHA-256 cert fingerprint | `DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF` — 32 obviously-fake bytes, format-valid so validators can be tested against it |
| Keystore | **never in the repo, in any form, at any size.** Not the file, not base64 of it, not its passwords, not its real fingerprint |
| SDK / JDK locations | never written down. CI gets them from the setup actions; local dev gets them from the environment |
| Room code in examples | `ABCD` |

Two mechanical guards, both cheap, both required:

1. A repo-wide test (`packages/invite/test/no-secrets.test.ts`) greps the tracked
   file list for: a `-----BEGIN` block, a `.jks`/`.keystore`/`.p12` path, an
   RFC1918 literal, and any 32-byte colon-hex string that is **not** the
   `DE:AD:BE:EF…` placeholder. It fails on a hit. This is the only test in the
   repository that reads the repository.
2. `.gitignore` carries `*.jks`, `*.keystore`, `*.p12`, `keystore.properties`,
   `local.properties`, `apps/android/local.properties`,
   `apps/android/app/src/main/assets/public/`, `apps/android/app/build/`,
   `apps/android/.gradle/`, `apps/web/dist/`, `apps/web/.vite/`.

`local.properties` matters more than it looks: Gradle writes the SDK path into it
automatically on first local build, and that path is a real host path.

---

## 2. What Plans 1–4 export that Plan 5 consumes

### 2.1 `@tapkart/render` — the audio seam, quoted exactly

Plan 3 contract §4.9, verbatim (`2026-08-14-tapkart-plan3-contract-DRAFT.md:806-835`;
the non-DRAFT file does not exist at the time of writing, and Plan 3's rulings
document leaves §4.9 unamended except to say the backend is Plan 5's):

```ts
export type AudioCueKind =
  | 'engine' | 'skid' | 'impact' | 'itemPickup' | 'itemUse'
  | 'boost' | 'spinOut' | 'respawn' | 'lapCross' | 'countdownBeep' | 'finish'

export interface AudioCue { kind: AudioCueKind; playerId: number; intensity: number; pan: number }

export interface AudioModel {
  engineFreqHz: number
  engineGain: number
  skidGain: number
  cues: AudioCue[]            // one-shots for THIS frame; cleared each build
  cueCount: number
}
export function createAudioModel(): AudioModel

/** Derives continuous levels from `view` and one-shots from the delta between
 *  `prev` and `view`. Pure and assertable; a test drives two views and asserts
 *  exactly which cues fire. */
export function buildAudioModel(prev: RaceView, view: RaceView, out: AudioModel): void

/** ADAPTER boundary. The Web Audio implementation lives behind this and is
 *  owner-verified. */
export interface AudioBackend {
  apply(model: AudioModel): void
  close(): void
}
```

Three consequences Plan 5 is bound by and no task may relitigate:

- **`AudioBackend` has exactly two methods.** No `resume()`, no `setVolume()`, no
  `mute()`. Everything else the Web Audio implementation needs is either folded
  into `AudioGraphConfig` (§8) or handled by `apps/web` outside the seam.
- **`cues` is cleared on every `buildAudioModel`.** Therefore
  `audio.apply(model)` must run in the *same frame*, after `buildAudioModel` and
  before the next one. §12 makes that a sole-writer rule.
- **`AudioModel` has no master volume and no enabled flag.** `Settings`
  (Plan 3 §5.7) has `audioEnabled` and `audioVolume`. The bridge between them is
  `WebAudioBackend.setConfig` (§8.2), not a new `AudioModel` field.

### 2.2 `@tapkart/game` — what the invite panel and the shell need

```ts
// packages/game/src/roomcode.ts     (Plan 3 §5.8)
export const ROOM_CODE_LENGTH = 4
export const ROOM_CODE_ALPHABET: string      // ambiguity-free: no O/0, no I/1
export function normalizeRoomCode(raw: string): string
export function isValidRoomCode(raw: string): boolean

// packages/game/src/shell.ts        (Plan 3 §5.12, ADAPTER)
export interface ShellOptions {
  canvas: HTMLCanvasElement
  root: HTMLElement
  clock: FrameClock
  store: KeyValueStore
  renderer: RendererBackend
  audio: AudioBackend | null
}
export interface GameShell { stop(): void }
export function startShell(opts: ShellOptions): GameShell
```

> `ShellOptions.fetchJson` was **deleted** by Plan 3 rulings Q12 (tracks are
> `import.meta.glob`-bundled). It is omitted above deliberately; a task that
> re-adds it is working from the pre-ruling draft.

**Plan 5 needs one field added: `nfc: NfcHost | null`.** That is an amendment to
a Plan 3 file, and §17 Q4 asks for it explicitly rather than assuming it.

### 2.3 `@tapkart/net`, `@tapkart/protocol`, `@tapkart/sim`

Plan 5 consumes **nothing** from these three directly. It ships them (they are in
the bundle) and it must not import them: an NFC codec that reaches into `sim` has
gone wrong somewhere upstream.

### 2.4 `packages/server` (Plan 4) — three facts Plan 5 depends on and cannot yet read

Plan 4 is in authoring and its contract does not exist at the time of writing.
Plan 5's Dockerfile, compose file and container smoke test all assume:

1. The server **serves the built `apps/web` static output**, from a directory it
   is told about (env var or argv) — spec §3: *"Server runs Node, serves the
   static PWA…"*.
2. The server serves **`/.well-known/assetlinks.json`** out of that static root,
   with `Content-Type: application/json` and **no redirect** (spec §2's hard
   precondition; spec §9 repeats it for the tunnel).
3. The server exposes a **health endpoint** and honours a **`PORT`** env var
   defaulting to `3031` (spec §9: "compose file, port 3031").

All three are §17 Q7/Q38/Q39. If any is false, the Dockerfile changes, not this
contract's assertions.

---

## 3. Five values that must agree, or App Links silently fails

This is Plan 5's equivalent of Plan 3 §6.3 — the failure that produces no error,
no log, and no failing test, and is invisible until a guest taps a phone.

Spec §2: *"on Android 12+ a failed verification is silent — no disambiguation
chooser, the link just opens in the browser."* The guest is not blocked (QR and
room code are always shown), so **nothing about a broken App Link is loud**. It
just quietly stops being an app.

| # | Value | Lives in | Source |
|---|---|---|---|
| 1 | the **host** in the `autoVerify` `ACTION_VIEW` intent filter | `AndroidManifest.xml`, as `${tapkartHost}` | Gradle `manifestPlaceholders`, from `TAPKART_ORIGIN` |
| 2 | the **origin** of the URI the HCE tag serves | runtime, from `import.meta.env.VITE_TAPKART_ORIGIN` | the same `TAPKART_ORIGIN` |
| 3 | the **host** actually serving `/.well-known/assetlinks.json` | the deployment | the same `TAPKART_ORIGIN` |
| 4 | `package_name` in `assetlinks.json` | container env `TAPKART_ANDROID_PACKAGE` | must equal Gradle `applicationId` |
| 5 | `sha256_cert_fingerprints[0]` in `assetlinks.json` | container env `TAPKART_SHA256_FINGERPRINTS` | must equal the SHA-256 of the certificate in the keystore that signed the installed APK |

**The rule: `TAPKART_ORIGIN` is the single source for 1, 2 and 3, and it is read
exactly once per build target.** Vite reads it as `VITE_TAPKART_ORIGIN`; Gradle
reads it as the `tapkartOrigin` project property and derives `tapkartHost` from it
by stripping the scheme. No task hardcodes a host anywhere else, and no task
introduces a second env var meaning the same thing.

**What CI can prove about this chain (§10.2):** 1 == 2 (both derived from one
variable, asserted in the merged manifest and in the built bundle); 4 == the
`applicationId` in the APK; 5 == the certificate that CI just signed the APK with
(`apksigner verify --print-certs`); and that the *container* serves a
shape-valid `assetlinks.json` at the right path with the right content type and
no redirect.

**What CI cannot prove:** that the origin the owner deploys behind Cloudflare
Tunnel is that container, or that Android's verifier succeeded. Those two are
§11's owner checklist, items 1 and 2.

---

## 4. `packages/invite` — module map and exact signatures

New package. **Zero dependencies. Pure. No DOM lib.** `tsconfig.json` is
`{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }`,
identical to `sim`'s — and unlike `render`/`game`/`apps/web` it needs no `lib`
widening, because nothing in it names a browser type.

```jsonc
// packages/invite/package.json
{ "name": "@tapkart/invite", "version": "0.1.0", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }
```

The name is **`@tapkart/invite`, not `@tapkart/nfc`**, because the package owns
every way a guest gets into a lobby — tap, QR and typed code all produce the same
URI — and spec §2 is explicit that all three ship together ("QR and a
four-character room code are **always** displayed alongside"). §17 Q1 offers the
alternative.

```ts
// packages/invite/src/hex.ts                                          PURE
/** Uppercase, unseparated. The one spelling of hex in this repository. */
export function bytesToHex(b: Uint8Array): string
/** Accepts uppercase, lowercase and embedded spaces; throws on odd length or a
 *  non-hex character. Used by fixtures and by nothing shipped. */
export function hexToBytes(s: string): Uint8Array

// packages/invite/src/uri.ts                                          PURE
/** NFC Forum URI Record Type Definition, abbreviation table, index 0x00..0x23.
 *  Index 0x04 is 'https://' and is the only one this game ever emits. */
export const NDEF_URI_PREFIXES: readonly string[]

/** A short NDEF record's payload length field is one byte. 250 leaves margin
 *  under 255 for the 'https://' abbreviation and the room code. */
export const MAX_INVITE_URI_BYTES = 250

/** Single well-known URI record: MB=1 ME=1 CF=0 SR=1 IL=0 TNF=001 -> 0xD1,
 *  type 'U' (0x55), payload = [prefixCode, ...rest]. Throws if the encoded
 *  payload would exceed 255 bytes. Emits NO Android Application Record (§6.4). */
export function encodeUriRecord(uri: string): Uint8Array

/** Inverse. Throws on a record that is not a single well-known 'U' record. */
export function decodeUriRecord(rec: Uint8Array): string

/** NLEN (u16 big-endian) followed by the message. `null` yields exactly
 *  `[0x00, 0x00]` — a valid, empty, readable tag (§5.5). */
export function buildNdefFile(uri: string | null): Uint8Array

/** Inverse. Returns null for NLEN === 0. Throws if NLEN exceeds the buffer. */
export function parseNdefFile(file: Uint8Array): string | null

// packages/invite/src/invite.ts                                       PURE
export const INVITE_PATH_PREFIX = '/j/'
/** Origin cap, so `buildInviteUri` can never produce an un-encodable record. */
export const MAX_INVITE_ORIGIN_BYTES = 200
export interface InviteUri { origin: string; roomCode: string }

/** `buildInviteUri('https://tapkart.example', 'ABCD')`
 *   -> 'https://tapkart.example/j/ABCD'.
 *  Throws on a trailing slash in `origin`, on a non-https scheme, on an origin
 *  longer than MAX_INVITE_ORIGIN_BYTES, or on a room code that
 *  `isValidRoomCode` would reject. The room code is upper-cased. */
export function buildInviteUri(origin: string, roomCode: string): string

/** Total: returns null rather than throwing, because its inputs come off a
 *  radio and off the address bar. Rejects any scheme but https, any path not
 *  starting with INVITE_PATH_PREFIX, and any malformed room code. */
export function parseInviteUri(uri: string): InviteUri | null
```

```ts
// packages/invite/src/t4t.ts                                          PURE
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

/** The 15-byte Capability Container, frozen. §5.2 breaks it down byte by byte. */
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
 *  MUST be called from HostApduService.onDeactivated — see §6.3. */
export function resetTag(state: TagState): void

/** The whole tag, as a pure function. Returns a fresh Uint8Array containing
 *  the response data followed by the two status-word bytes. Never throws:
 *  every malformed input maps to a status word in the §5.4 table. */
export function processApdu(state: TagState, apdu: Uint8Array): Uint8Array
```

```ts
// packages/invite/src/reader.ts                                       PURE
/** The guest-side half: the same exchange, driven. */
export function buildSelectAidApdu(): Uint8Array
export function buildSelectFileApdu(fileId: number): Uint8Array
/** `offset` 0..0xFFFF big-endian into P1P2; `length` 1..MLE. */
export function buildReadBinaryApdu(offset: number, length: number): Uint8Array
export function isStatusOk(resp: Uint8Array): boolean
/** The response minus its two status bytes. Empty array if there are none. */
export function responseBody(resp: Uint8Array): Uint8Array

/** One ISO-DEP round trip. Implemented by IsoDep on Android, by the loopback
 *  `processApdu` in tests. */
export type Transceive = (command: Uint8Array) => Promise<Uint8Array>

/** SELECT app -> SELECT CC -> read CC -> SELECT NDEF -> read NLEN -> read body,
 *  chunked at the CC's advertised MLe. Returns the URI, or null if any step
 *  returns a non-9000 status or the message is empty. Never throws on a
 *  protocol error; propagates only errors thrown by `t` itself. */
export function readInvite(t: Transceive): Promise<string | null>
```

```ts
// packages/invite/src/host.ts                                         PURE (interface only)
export interface NfcSupport {
  /** Device has NFC hardware. */ hardware: boolean
  /** Device supports Host Card Emulation. */ hce: boolean
  /** NFC is switched on right now. */ adapterEnabled: boolean
}

/** The seam. `apps/web` supplies a Capacitor-backed implementation on Android
 *  and `nullNfcHost` everywhere else. `packages/game` may hold one and must
 *  never construct one. */
export interface NfcHost {
  supported(): Promise<NfcSupport>
  /** Idempotent. Starts emulating a tag serving `uri` and keeps the screen on. */
  advertise(uri: string): Promise<void>
  /** Idempotent. Serves the empty NDEF file and releases the screen lock. */
  stop(): Promise<void>
  /** Guest side. Returns an unsubscribe function. */
  onTagRead(cb: (uri: string) => void): () => void
}

/** Every method resolves; `supported()` reports all false; `onTagRead` returns
 *  a no-op unsubscribe. Browsers and desktop get this. */
export const nullNfcHost: NfcHost
```

```ts
// packages/invite/src/applinks.ts                                     PURE
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
```

```ts
// packages/invite/src/qr.ts                                           PURE
/** Row-major, `size * size` booleans, true = dark. Quiet zone NOT included;
 *  the drawer adds QR_QUIET_ZONE modules of margin. */
export interface QrMatrix { size: number; modules: Uint8Array }
export const QR_QUIET_ZONE = 4
export const QR_ECC_LEVEL = 'M'
/** Byte mode, ECC level M, smallest version that fits. Throws above version 10
 *  (which MAX_INVITE_ORIGIN_BYTES guarantees we never reach). */
export function buildQrMatrix(text: string): QrMatrix
export function qrModuleAt(m: QrMatrix, x: number, y: number): boolean
```

QR belongs to Plan 5 because **nobody else claimed it**: it appears in spec §2 and
§11 as a hard requirement ("QR and a four-character room code are always displayed
alongside… Nobody is ever blocked from joining"), and it is absent from Plan 3's
contract, Plan 3's rulings and Plan 2's contract. §17 Q2 covers whether the
encoder is written here or pulled in as a pinned dependency.

`src/index.ts` re-exports `hex`, `uri`, `invite`, `t4t`, `reader`, `host`,
`applinks`, `qr` — all eight, because all eight are pure and headless-safe. This
package has no adapter half to keep out of the barrel.

---

## 5. The APDU exchange, byte by byte

This section exists because it is **the one part of NFC that CI can genuinely
test**. Two physical phones cannot meet in a GitHub Actions runner, but the bytes
they would exchange are a pure function over byte arrays, and that function is
implemented **twice** — once in TypeScript (`processApdu`) and once in Kotlin
(`T4tTag.process`) — and both are driven from the same fixture (§5.6).

Everything below is normative. A task that "simplifies" a status word or a CC
byte breaks the fixture, in both languages, loudly.

### 5.1 The command set — four commands, and nothing else

| # | Name | C-APDU (hex) | Precondition | Response |
|---|---|---|---|---|
| 1 | SELECT NDEF application, by DF name | `00 A4 04 00 07 D2 76 00 00 85 01 01` optionally followed by `00` (Le) | none | `90 00`; `selected := 'app'` |
| 2 | SELECT CC file, by file ID | `00 A4 00 0C 02 E1 03` | `selected !== 'none'` | `90 00`; `selected := 'cc'` |
| 3 | SELECT NDEF file, by file ID | `00 A4 00 0C 02 E1 04` | `selected !== 'none'` | `90 00`; `selected := 'ndef'` |
| 4 | READ BINARY | `00 B0 <offHi> <offLo> <Le>` | `selected` is `'cc'` or `'ndef'` | `<data> 90 00` |

Both spellings of command 1 (12 bytes, and 13 with a trailing `00` Le) are
accepted, because readers in the wild send both. The response carries no FCI
template; `90 00` alone is what Android's reader expects and what the fixture
pins.

`P2 = 0x0C` on commands 2 and 3 means "first or only occurrence, return no FCI".
`P1 = 0x00` means "select by file identifier". These are not free choices: they
are what the NFC Forum Type 4 Tag operation specifies, and an Android reader sends
exactly them.

### 5.2 `CC_FILE`, byte by byte

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

Full hex: `000F2000F600FF0406E104040000FF` — 15 bytes.

Write access is **denied**, permanently and by design. A writable emulated tag is
a way for a stranger's phone to change what the host is advertising.

### 5.3 READ BINARY length rules

- `Le === 0x00` means **256**, per ISO 7816-4.
- The tag returns `min(Le, MLE, fileLength - offset)` bytes and `90 00`.
- **Over-reading is truncated, not rejected.** Android's Type 4 reader never
  over-reads (it reads NLEN first and chunks at MLe), so the lenient branch is
  never taken by the reader we care about; being lenient means an unusual reader
  gets a usable answer instead of a dead tag. §17 Q19 offers `6C XX` instead.
- `offset >= fileLength` is **not** truncation, it is `6B 00`. There is no
  legitimate reason to start a read past the end of a file whose length the
  reader was just told.

### 5.4 The error table

| Condition | SW |
|---|---|
| `CLA !== 0x00` | `6E 00` |
| `INS` not `A4` or `B0` | `6D 00` |
| APDU shorter than 4 bytes, or a length triple that does not parse as ISO 7816 case 1–4, or an extended-length APDU | `67 00` |
| SELECT with `P1P2` not `0400` and not `000C` | `6A 86` |
| SELECT by name with an AID that is not `NDEF_AID` | `6A 82` |
| SELECT by ID with a file ID other than `E103`/`E104` | `6A 82` |
| SELECT by ID while `selected === 'none'` | `69 85` |
| READ BINARY while `selected` is `'none'` or `'app'` | `69 86` |
| READ BINARY with `offset >= fileLength` | `6B 00` |

APDU case parsing, pinned so both languages do it identically:

```
len === 4                 -> case 1 (no Lc, no Le)
len === 5                 -> case 2 (byte[4] is Le; 0x00 means 256)
len === 5 + byte[4]       -> case 3 (byte[4] is Lc, then data)
len === 6 + byte[4]       -> case 4 (byte[4] is Lc, then data, then Le)
anything else             -> 67 00
byte[4] === 0x00 && len > 5 -> 67 00   (extended length, unsupported)
```

### 5.5 The advertising and non-advertising states

`TagState.ndefFile` is **always a valid file**. It is `00 00` (NLEN = 0) when the
host is not advertising, and NLEN-prefixed message bytes when it is.

Selects always succeed regardless. A reader that taps a non-advertising host gets
a well-formed empty tag and does nothing — which is exactly right, and strictly
better than a `6A 82` that some readers surface to the user as an error.

`selected` resets to `'none'` on `resetTag`, which the Android service calls from
`onDeactivated`. **This is the single most likely Kotlin-side bug in the plan:** an
HCE service instance is reused across taps, so a state machine that does not reset
starts the second tap mid-conversation, and the second guest of the evening gets
nothing while the first got everything. §6.3 makes it a sole-writer rule and §5.6
makes it a fixture case.

### 5.6 The golden exchange — the fixture both languages replay

For `TAPKART_ORIGIN = https://tapkart.example` and room code `ABCD`, the invite
URI is `https://tapkart.example/j/ABCD`.

NDEF record: `D1 01 17 55 04` then the 22 ASCII bytes of `tapkart.example/j/ABCD`
(the `https://` is the `04` prefix code), payload length `0x17` = 23, record
length 27, so NLEN = `00 1B` and the NDEF file is 29 bytes:

```
001BD1011755047461706B6172742E6578616D706C652F6A2F41424344
```

The full exchange, which is what `packages/invite/vectors/t4t-exchange.tsv`
contains:

| Step | → Command | ← Response | `selected` after |
|---|---|---|---|
| 1 | `00A4040007D276000085010100` | `9000` | `app` |
| 2 | `00A4000C02E103` | `9000` | `cc` |
| 3 | `00B000000F` | `000F2000F600FF0406E104040000FF` `9000` | `cc` |
| 4 | `00A4000C02E104` | `9000` | `ndef` |
| 5 | `00B0000002` | `001B` `9000` | `ndef` |
| 6 | `00B000021B` | `D1011755047461706B6172742E6578616D706C652F6A2F41424344` `9000` | `ndef` |

Plus the negative cases, in the same file: `00A4040007A0000002471001` → `6A82`;
`00B0000002` from `selected === 'none'` → `6986`; `00A4000C02E103` from
`selected === 'none'` → `6985`; `80B0000002` → `6E00`; `00C0000000` → `6D00`;
`00A4040107D2760000850101` → `6A86`; `00B0FFFF02` on the 29-byte file → `6B00`;
and the whole happy path replayed **after** a `resetTag`, asserting step 5 from a
reset state returns `6986`.

### 5.7 Fixture format — line-oriented, not JSON

```
# t4t-exchange.tsv — version 1
# NAME <TAB> COMMAND_HEX <TAB> RESPONSE_HEX <TAB> SELECTED_AFTER <TAB> RESET_BEFORE
selectApp	00A4040007D276000085010100	9000	app	1
selectCc	00A4000C02E103	9000	cc	0
```

Tab-separated, `#` comments, uppercase unseparated hex, one exchange per line.
`RESET_BEFORE` is `1`/`0`. A second file,
`packages/invite/vectors/ndef-uri.tsv`, is `URI <TAB> NDEF_FILE_HEX`.

**Not JSON, deliberately.** `org.json` is stubbed in Android JVM unit tests
(`testOptions.unitTests.returnDefaultValues` either throws or silently returns
zeros), so a JSON fixture forces a JSON dependency into the Android test
classpath to read a file that has no nesting in it. Ten lines of `split('\t')` on
each side has no such failure mode. §17 Q20 offers Gson + JSON as the alternative.

Both suites read the same two files:

- vitest: `packages/invite/test/vectors.test.ts` reads them with `node:fs`, the
  same test-only disk reach Plan 2 §6 and Plan 3 rulings Q34 already permit.
- Gradle: `apps/android/app/build.gradle.kts` adds
  `sourceSets["test"].resources.srcDir("$rootDir/../../packages/invite/vectors")`
  and the Kotlin test reads them off the test classpath. Repo-relative, no host
  path.

**What this proves:** the two implementations agree, byte for byte, on every
command in the table including the error cases. **What it does not prove:** that
any of it happens over a radio. §11.

---

## 6. `apps/android` — the Capacitor project

### 6.1 Layout and identity

```
apps/android/
  capacitor.config.ts        webDir: '../web/dist',  android: { path: '.' }
  package.json               workspace member; pins @capacitor/* (§17 Q31)
  settings.gradle
  build.gradle
  gradle/wrapper/            wrapper jar + properties, committed
  gradlew, gradlew.bat
  app/
    build.gradle             applicationId, signingConfigs, manifestPlaceholders
    src/main/AndroidManifest.xml
    src/main/res/xml/apduservice.xml
    src/main/res/xml/config.xml            (Capacitor)
    src/main/kotlin/io/github/atvriders/tapkart/MainActivity.kt
    src/main/kotlin/io/github/atvriders/tapkart/nfc/*.kt
    src/test/kotlin/io/github/atvriders/tapkart/nfc/*Test.kt      JVM, no device
```

- `applicationId = "io.github.atvriders.tapkart"`, overridable by the Gradle
  property `tapkartApplicationId`. It must equal `TAPKART_ANDROID_PACKAGE` in the
  deployment (§3, value 4).
- `namespace` equals the applicationId.
- `minSdk`, `compileSdk`, `targetSdk`, AGP and Gradle versions come from the
  Capacitor template **unmodified**, except that `targetSdk` must be at least the
  Android 16 API level, because spec §2's whole App Links argument is about
  Android 16 behaviour. §17 Q31.
- Web assets are copied in by `npx cap sync android`; the copy
  (`app/src/main/assets/public/`) is **gitignored** (§1). The APK therefore
  bundles the PWA and works offline; it does not point a WebView at a remote
  origin. §17 Q10.

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
  <intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW"/>
    <category android:name="android.intent.category.DEFAULT"/>
    <category android:name="android.intent.category.BROWSABLE"/>
    <data android:scheme="https" android:host="${tapkartHost}" android:pathPrefix="/j/"/>
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

`launchMode="singleTask"` is required, not cosmetic: without it, a verified App
Link opened while the app is already running starts a *second* task and the guest
lands on a fresh title screen instead of the lobby they were invited to.

`res/xml/apduservice.xml`:

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

`requireDeviceUnlock="true"` matches spec §2's stated limit — *"The host's screen
must be on and unlocked for HCE to respond"* — rather than quietly widening it.
§17 Q15.

### 6.3 Kotlin signatures

```kotlin
package io.github.atvriders.tapkart.nfc

// Hex.kt — PURE
object Hex {
    fun encode(bytes: ByteArray): String            // uppercase, unseparated
    fun decode(s: String): ByteArray                // tolerant of spaces and case
}

// NdefUri.kt — PURE. Mirrors packages/invite/src/uri.ts exactly.
object NdefUri {
    const val MAX_INVITE_URI_BYTES: Int = 250
    fun encodeUriRecord(uri: String): ByteArray
    fun buildNdefFile(uri: String?): ByteArray      // null -> byteArrayOf(0, 0)
    fun parseNdefFile(file: ByteArray): String?
}

// T4tTag.kt — PURE. Mirrors packages/invite/src/t4t.ts exactly.
class T4tTag {
    enum class Selected { NONE, APP, CC, NDEF }

    val selected: Selected                          // read-only to callers
    fun setUri(uri: String?)                        // sole writer of ndefFile
    fun reset()                                     // sole writer of selected, besides process()
    fun process(apdu: ByteArray): ByteArray         // never throws

    companion object {
        val AID: ByteArray                          // D2760000850101
        val CC_FILE: ByteArray                      // the 15 bytes of §5.2
        const val MLE: Int = 0x00F6
        const val MLC: Int = 0x00FF
    }
}

// LobbyAdvert.kt — ADAPTER (process-global + SharedPreferences)
object LobbyAdvert {
    @Volatile var uri: String?                      // sole writer: TapkartNfcPlugin
    fun load(context: Context)                      // restores after process death
    fun store(context: Context, uri: String?)
    const val PREFS_NAME: String = "tapkart_nfc"
    const val KEY_LOBBY_URI: String = "lobby_uri"
}

// TapkartHceService.kt — ADAPTER
class TapkartHceService : HostApduService() {
    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray
    override fun onDeactivated(reason: Int)         // MUST call tag.reset()
}

// InviteReader.kt — ADAPTER
object InviteReader {
    /** Wraps IsoDep in a Transceive and runs the §5 reader script. Returns the
     *  URI or null. Connect/close are its responsibility. */
    fun read(isoDep: IsoDep): String?
}
```

```kotlin
package io.github.atvriders.tapkart

// TapkartNfcPlugin.kt — ADAPTER (the Capacitor bridge)
@CapacitorPlugin(name = "TapkartNfc")
class TapkartNfcPlugin : Plugin() {
    @PluginMethod fun isSupported(call: PluginCall)      // -> { hardware, hce, adapterEnabled }
    @PluginMethod fun startAdvertising(call: PluginCall) // { uri: String }
    @PluginMethod fun stopAdvertising(call: PluginCall)
    @PluginMethod fun startReader(call: PluginCall)      // emits 'tagRead'
    @PluginMethod fun stopReader(call: PluginCall)
    override fun handleOnPause()                          // stops reader mode
    override fun handleOnResume()                         // restores reader mode if it was on
}

// MainActivity.kt — ADAPTER
class MainActivity : BridgeActivity()                     // registers TapkartNfcPlugin
```

Four behaviours that are decisions, not implementation detail, and are therefore
pinned here:

1. **`startAdvertising` sets `FLAG_KEEP_SCREEN_ON` on the activity window, and
   `stopAdvertising` clears it.** Spec §2: HCE does not answer with the screen
   off. A host whose phone sleeps while the lobby is open has silently stopped
   being tappable, and no amount of correct APDU handling fixes it.
2. **`startAdvertising` calls `CardEmulation.setPreferredService(activity, component)`
   and `stopAdvertising` calls `unsetPreferredService`.** AID `D2760000850101` in
   category `other` can be claimed by more than one installed app; the preferred
   service call is what guarantees ours wins while the lobby is on screen.
3. **Reader mode is enabled only while the guest is on a screen that can act on a
   tap**, with flags `FLAG_READER_NFC_A | FLAG_READER_NFC_B |
   FLAG_READER_SKIP_NDEF_CHECK | FLAG_READER_NO_PLATFORM_SOUNDS`, and it is
   disabled in `handleOnPause`. Skipping the platform NDEF check is what stops
   Android from also firing its own dispatch for the tag we are reading.
4. **A tag read that does not `parseInviteUri` into our origin is dropped
   silently.** The guest's phone will be tapped against transit cards and hotel
   keys; a modal error for each is worse than nothing happening.

### 6.4 No Android Application Record

The NDEF message contains a URI record and nothing else. An AAR
(`android.com:pkg`) would send a guest **without** the app to the Play Store, and
this game is distributed as a GitHub Release asset (spec §9), so that lands them
on an error page. App Links already routes the URL into the app when the app is
installed; the AAR buys nothing and costs a dead end. §17 Q22.

### 6.5 Signing

```groovy
signingConfigs {
    release {
        storeFile file(System.getenv('TAPKART_KEYSTORE_PATH') ?: 'nonexistent.jks')
        storePassword System.getenv('TAPKART_KEYSTORE_PASSWORD')
        keyAlias System.getenv('TAPKART_KEY_ALIAS')
        keyPassword System.getenv('TAPKART_KEY_PASSWORD')
    }
}
```

- The keystore is **generated once by the owner, out of band**, before the first
  release build, and backed up the day it is created (spec §9, spec §11's
  "Losing the signing keystore" row). The repo documents *how* in `README.md` and
  never carries the artifact.
- In CI, `ANDROID_KEYSTORE_BASE64` is decoded to `$RUNNER_TEMP`, **never into the
  workspace**, and never uploaded as an artifact.
- A build with no keystore env produces an **unsigned** release APK and CI fails
  it at the §10.2 fingerprint check rather than shipping it. Debug builds sign
  with the local debug keystore as usual and are never released.
- Spec §2 permits `assetlinks.json` to list several fingerprints so a locally
  built debug APK also verifies. That is supported by
  `TAPKART_SHA256_FINGERPRINTS` being a **list**; the debug fingerprint is the
  owner's local machine's and therefore never enters the repo. §17 Q25.

---

## 7. PWA — manifest, service worker, offline, install

All of this lands in `apps/web`, which Plan 3 creates as a Vite shell (rulings
Q11). Plan 5 adds:

```
apps/web/
  public/manifest.webmanifest
  public/icons/            generated at build, gitignored
  src/pwa/policy.ts        PURE
  src/pwa/install.ts       PURE
  src/pwa/update.ts        PURE
  src/sw.ts                ADAPTER (service worker entry)
  src/platform/env.ts      PURE-ish (reads import.meta.env, no side effects)
  src/platform/nfc.ts      ADAPTER (Capacitor bridge -> NfcHost)
  src/platform/audio.ts    ADAPTER (the only AudioContext constructor)
  tools/precache.mjs       build tool
  tools/png.mjs            build tool
  tools/build-sw.mjs       build tool
  tools/write-assetlinks.ts  container entrypoint tool (bundled by esbuild)
  test/*.test.ts
```

### 7.1 `public/manifest.webmanifest`

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

`scope: "/"` covers `/j/ABCD`, so a guest who installs after arriving by tap keeps
the invite inside the app's scope. `start_url` is `/` because a saved invite code
is stale the moment the room expires.

Icons are **generated at build time** by `tools/png.mjs` + `tools/gen-icons` into
`public/icons/`, which is gitignored — no binaries in git, and the generator is a
pure function CI can assert (`encodePng` emits a correct signature, IHDR and CRC;
`drawIconRgba` is deterministic). §17 Q33.

### 7.2 The service worker

```ts
// apps/web/src/pwa/policy.ts                                          PURE
/** A plain struct, deliberately: the pure layer never names `Request`, so these
 *  tests need no DOM and no jsdom (Plan 3 rulings Q30). sw.ts converts. */
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

The routing rules, pinned:

| Request | Action |
|---|---|
| method !== `GET` | `passthrough` |
| cross-origin | `passthrough` |
| path starts with any of `NEVER_CACHE_PREFIXES` — `/.well-known/`, `/api/`, `/signal`, `/ws`, `/healthz` | `networkOnly` |
| `isNavigate` | `shellFallback` |
| path is in `cfg.precache` | `cacheFirst` |
| any other same-origin GET | `networkFirst` |

`/.well-known/` being `networkOnly` is not about the Android verifier — that
fetch never passes through a page's service worker — it is so a developer never
debugs a stale `assetlinks.json` served out of a browser cache.

```ts
// apps/web/src/sw.ts                                                  ADAPTER
// The only file in the repository with `/// <reference lib="webworker" />`.
// `const sw = self as unknown as ServiceWorkerGlobalScope` — pinned idiom, so
// two tasks do not invent two ways to type `self` (§17 Q47).
```

Behaviour:
- `install`: open `cfg.cacheName`, `addAll(cfg.precache)`, then **do not**
  `skipWaiting`.
- `activate`: delete every cache whose name starts with `tapkart-` and is not
  `cfg.cacheName`; `clients.claim()`.
- `fetch`: build an `SwRequestInfo`, call `routeRequest`, execute the action. No
  other branching.
- `message`: `{ type: 'SKIP_WAITING' }` calls `sw.skipWaiting()` — and nothing
  else sends that message except §7.3's update flow.

**The service worker never activates over a running race.** Auto-`skipWaiting`
would swap the JS bundle under a live authority loop; the update lands when the
player is on the results or title screen, or on the next cold load.

### 7.3 Update and install, as pure reducers

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
`available` simply stays false there and no instructional UI is shipped in v1.

### 7.4 Build tooling

```js
// apps/web/tools/precache.mjs
export function buildPrecacheList(viteManifest, extras)  // -> sorted absolute paths
export function precacheVersion(list)                    // -> short stable hash of the list

// apps/web/tools/png.mjs
export function encodePng(width, height, rgba)           // -> Uint8Array, zlib via node:zlib
export function drawIconRgba(size, palette)              // -> Uint8Array, deterministic
```

These are `.mjs`, not `.ts`, so vitest can import them with no loader and
`tsc` can ignore them: build tooling is not shipped code and does not need to be
in the typecheck. `tools/write-assetlinks.ts` is the exception — it imports
`@tapkart/invite` for real (§9.3) and is therefore TypeScript, bundled by
`esbuild` in the Docker build stage. §17 Q30.

### 7.5 The two platform adapters

```ts
// apps/web/src/platform/env.ts                                        PURE
/** The deployed origin, baked in at build time. §3's single source, web half.
 *  Trailing slash stripped at module load; throws at load if unset in a
 *  production build, because every invite URI in the app depends on it. */
export const TAPKART_ORIGIN: string
/** True inside the Capacitor WebView, where `location.origin` is NOT the
 *  deployed origin and must never be used to build an invite. */
export const IS_NATIVE: boolean
/** TAPKART_ORIGIN always. Exists so no call site is tempted to reach for
 *  `location.origin`, which is right in the browser and wrong in the APK. */
export function appOrigin(): string
```

```ts
// apps/web/src/platform/nfc.ts                                        ADAPTER
/** The Capacitor bridge's shape, declared here rather than imported, so the
 *  plugin's TS surface and the Kotlin @PluginMethod list are compared by
 *  review against one written-down thing. */
export interface TapkartNfcPluginBridge {
  isSupported(): Promise<NfcSupport>
  startAdvertising(options: { uri: string }): Promise<void>
  stopAdvertising(): Promise<void>
  startReader(): Promise<void>
  stopReader(): Promise<void>
  addListener(eventName: 'tagRead', cb: (ev: { uri: string }) => void): Promise<{ remove(): Promise<void> }>
}

/** Returns the Capacitor-backed NfcHost on Android, `nullNfcHost` everywhere
 *  else. The only `registerPlugin` call in the repository. Contains no
 *  decisions beyond that one platform check. */
export function capacitorNfcHost(): NfcHost
```

`tools/build-sw.mjs` runs after the main Vite build, reads
`dist/.vite/manifest.json`, computes the precache list and version, and invokes a
second Vite build for `src/sw.ts` with `define: { __PRECACHE__, __SW_VERSION__ }`
and `emptyOutDir: false`, emitting **`dist/sw.js`** — unhashed, at the scope root,
because a service worker's scope is its own path.

---

## 8. The Web Audio backend

### 8.1 Where it lives

`packages/render/src/audio-graph.ts` (pure) and `packages/render/src/web/audio.ts`
(adapter), with a new `"./audio"` entry in `packages/render`'s `exports` map,
mirroring exactly what Plan 3 did for `"./three"`:

```jsonc
"exports": {
  ".": "./src/index.ts",
  "./three": "./src/three/renderer.ts",
  "./audio": "./src/web/audio.ts"
}
```

This is where Plan 3's rulings Q26 points — *"the seam is kept and authored… so
Plan 5 adds a Web Audio implementation and touches nothing else"* — and it keeps
the pure planner next to the pure model it plans from. `audio-graph.ts` **is**
re-exported from the barrel; `web/audio.ts` **is not**, because it names
`AudioContext` and Plan 3 §8.2's rule is that no adapter reaches the headless
barrel. §17 Q3.

### 8.2 Signatures

```ts
// packages/render/src/audio-graph.ts                                  PURE
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
/** One entry per AudioCueKind. The whole sound design of the game, as data. */
export const ONE_SHOT_SPECS: Readonly<Record<AudioCueKind, OneShotSpec>>

export interface AudioGraphConfig {
  enabled: boolean            // Settings.audioEnabled
  masterGain: number          // Settings.audioVolume, 0..1
  engineSmoothingMs: number
  maxOneShotsPerFrame: number
}
export const DEFAULT_AUDIO_GRAPH_CONFIG: Readonly<AudioGraphConfig>
export const MAX_AUDIO_OPS = 32
export const MAX_ONE_SHOTS_PER_FRAME = 4

export function createAudioOpList(): AudioOpList
/** Sole writer of AudioOpList. Allocation-free: `out.ops` is preallocated to
 *  MAX_AUDIO_OPS and `out.count` says how many are live, exactly as
 *  WireSnapshot.entityCount does. `enabled: false` emits one 'silence' op and
 *  nothing else. */
export function planAudio(model: AudioModel, cfg: Readonly<AudioGraphConfig>, out: AudioOpList): void
```

```ts
// packages/render/src/web/audio.ts                                    ADAPTER
export interface WebAudioOptions { config: AudioGraphConfig }

/** `typeof AudioContext !== 'undefined'`. Nothing else. */
export function isWebAudioAvailable(): boolean

/** AudioBackend plus the one thing the seam cannot carry: a live settings
 *  change. `AudioBackend` has exactly two methods (§2.1) and `AudioModel` has
 *  no volume field, so the shell holds this wider type and the game holds the
 *  narrow one. */
export type WebAudioBackend = AudioBackend & { setConfig(next: Readonly<AudioGraphConfig>): void }

/** Takes an ALREADY-CONSTRUCTED, already-resumed AudioContext. It does not
 *  construct one, because construction must happen inside a user gesture and
 *  this function is called from composition, not from an event handler. */
export function createWebAudioBackend(context: AudioContext, opts?: Partial<WebAudioOptions>): WebAudioBackend
```

### 8.3 The voice budget

Plan 3 rulings Q26: *"local kart engine voice only, plus one-shots for items,
impacts and lap crossings. Eight oscillators for eight engines is a mobile battery
problem and a mix nobody can hear through."* Binding. The graph is:

- **one** engine voice: sawtooth oscillator → lowpass → gain → panner → master.
  Frequency and gain follow `AudioModel.engineFreqHz`/`engineGain` via
  `setTargetAtTime` with `engineSmoothingMs`; never `setValueAtTime`, which
  zippers audibly.
- **one** skid voice: a looping noise buffer (generated once, at construction) →
  bandpass → gain → master.
- **at most `MAX_ONE_SHOTS_PER_FRAME`** transient voices per frame, each created
  from its `OneShotSpec`, disconnected on `ended`, capped at 12 live.
- **one** master gain → destination.

`close()` stops both continuous voices, disconnects everything, and does **not**
close the `AudioContext` — the context belongs to `apps/web` (§12).

### 8.4 The gesture gate

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
gate fires, `ShellOptions.audio` is `null`, which Plan 3 already allows.

---

## 9. Deploy

### 9.1 Image

- Registry: **`ghcr.io/atvriders/tapkart`**. Multi-arch **`linux/amd64,linux/arm64`**.
  **Public, always** — this repo's standing rule, and a first publish that lands
  private is a bug to fix, not a state to accept.
- Multi-stage `Dockerfile` at the repo root:
  - `build` stage on `node:20-alpine`: `npm ci` at the root (workspaces),
    `npm run build -w apps/web`, the Plan 4 server build, and
    `npx esbuild apps/web/tools/write-assetlinks.ts --bundle --platform=node
     --format=esm --outfile=/app/dist-tools/write-assetlinks.mjs`.
  - `runtime` stage on `node:20-alpine`: production `node_modules`, the server
    output, `apps/web/dist`, `dist-tools`, `docker/entrypoint.sh`. Runs as the
    non-root `node` user. `EXPOSE 3031`. `HEALTHCHECK` hits the server's health
    endpoint on `127.0.0.1`.
- `docker-compose.yml`: one service, `image: ghcr.io/atvriders/tapkart:latest`,
  `ports: ["3031:3031"]`, `restart: unless-stopped`, and the four env vars below,
  each with a placeholder value and a comment saying the owner substitutes it.

### 9.2 Environment

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | no (default `3031`) | listen port |
| `TAPKART_ORIGIN` | yes | the deployed origin; §3's single source |
| `TAPKART_ANDROID_PACKAGE` | no | `applicationId` of the released APK |
| `TAPKART_SHA256_FINGERPRINTS` | no | comma-separated SHA-256 cert fingerprints |

### 9.3 `assetlinks.json` is generated at container start, not committed

`docker/entrypoint.sh` runs `node /app/dist-tools/write-assetlinks.mjs` and then
`exec`s the server.

```ts
// apps/web/tools/write-assetlinks.ts
/** Reads TAPKART_ANDROID_PACKAGE and TAPKART_SHA256_FINGERPRINTS, builds the
 *  statement with buildAssetLinks(), validates it with validateAssetLinks(),
 *  and writes <staticRoot>/.well-known/assetlinks.json.
 *  - both unset  -> writes nothing, logs one line, exit 0 (a self-hoster with
 *                   no APK does not need App Links)
 *  - set and bad -> logs the problems from validateAssetLinks and exit 1
 *  Returns the list of problems, so a test can call it directly. */
export function writeAssetLinks(env: Record<string, string | undefined>, staticRoot: string): string[]
```

It imports `@tapkart/invite` — the real shipped validator, not a reimplementation,
per the standing rule from Plan 3 rulings Q2 (*"A gate that reimplements
validation tests the gate"*).

The alternative — committing the file with real values — is forbidden by §1, and
committing it with placeholder values is worse: it would produce a deployment that
serves a *valid-looking* `assetlinks.json` naming a fingerprint that signs
nothing, which is precisely spec §2's silent-failure mode with a false trail of
evidence.

### 9.4 APK distribution

Spec §9: *"published as a GitHub Release asset, since the owner is responsible for
on-device NFC verification."* One `app-release.apk` per `v*` tag, uploaded to that
tag's Release. No Play Store, no App Bundle, no internal track.

---

## 10. CI/CD

### 10.1 Workflows

**`.github/workflows/ci.yml`** — on `push` and `pull_request`:

| Job | Runs |
|---|---|
| `web` | `npm ci`; `npm run typecheck`; `npm test`; `npm run build -w apps/web`; the §10.2 static assertions on `dist/` |
| `android` | `setup-java` JDK **21** (spec §9); `setup-android` (SDK + licences); Gradle cache; `./gradlew :app:testDebugUnitTest` (the §5.6 vectors, in Kotlin); `./gradlew :app:assembleDebug`; the §10.2 manifest assertions on the **merged** manifest |
| `e2e` | Playwright, including the offline specs of §10.3 |
| `container` | build the image for the host arch only, run it, and execute the §10.2 container assertions |

**`.github/workflows/release.yml`** — on `push` of a `v*` tag:

| Job | Runs |
|---|---|
| `image` | QEMU + Buildx + login (`GITHUB_TOKEN`, `packages: write`) → push `linux/amd64,linux/arm64` to `ghcr.io/atvriders/tapkart`, tags `latest` and the version |
| `apk` | decode `ANDROID_KEYSTORE_BASE64` into `$RUNNER_TEMP`; `./gradlew :app:assembleRelease`; `apksigner verify --print-certs`; assert the printed SHA-256 equals `vars.TAPKART_SHA256_FINGERPRINTS`'s first entry; upload the APK to the Release |

Secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`. Variables: `TAPKART_ORIGIN`, `TAPKART_ANDROID_PACKAGE`,
`TAPKART_SHA256_FINGERPRINTS`.

Ecosystem facts this repo has already paid to learn, recorded so nobody
rediscovers them: Actions are enabled for the `Atvriders` org and GHCR packages
publish and default to public; a **forked** repo's first workflow run needs a
manual `workflow_dispatch` before push-triggered runs work; and a PR from a fork
has **no secrets**, which is why release signing is tag-only and PRs build debug.

### 10.2 The assertions CI actually makes — enumerated, because §11 depends on it

**Pure, in vitest:**

1. `processApdu` against every line of `t4t-exchange.tsv`, response bytes and
   `selected` compared exactly.
2. `buildNdefFile`/`parseNdefFile` against every line of `ndef-uri.tsv`,
   round-trip and exact bytes.
3. `CC_FILE` equals the 15 bytes of §5.2, byte for byte.
4. `readInvite` driven against `processApdu` through a synchronous `Transceive`
   — the reader and the tag, proven against each other with no radio.
5. `buildInviteUri`/`parseInviteUri` round-trip; every rejection case returns
   `null` rather than throwing.
6. `isValidFingerprint` accepts the §1 placeholder and rejects: lowercase,
   31 bytes, 33 bytes, missing colons, and a SHA-1-length string.
7. `validateAssetLinks` returns `[]` for `buildAssetLinks(...)` output and names
   the field for each of: wrong relation, wrong namespace, absent package,
   empty fingerprint list, malformed fingerprint.
8. `routeRequest` over the §7.2 table, every row.
9. `planAudio`: `enabled: false` yields exactly one `silence` op; more cues than
   `MAX_ONE_SHOTS_PER_FRAME` yields exactly `MAX_ONE_SHOTS_PER_FRAME` one-shots;
   every emitted `gain` is within `[0, 1]`; `count <= MAX_AUDIO_OPS`.
10. `buildQrMatrix`: `size === 4 * version + 17`; the three finder patterns are
    present at the three corners; a committed golden matrix for the §5.6 invite
    URI still matches.
11. `encodePng` emits a valid signature, IHDR and CRC-correct chunks at the
    manifest's declared sizes.
12. The §1 no-secrets grep over the tracked file list.

**In Kotlin, on the JVM, no device:**

13. `T4tTag.process` against the **same** `t4t-exchange.tsv`.
14. `NdefUri` against the **same** `ndef-uri.tsv`.

**Structural, over declaration files (the merged manifest, not the source one):**

15. Exactly one `<intent-filter>` carries `android:autoVerify="true"`, and it has
    `ACTION_VIEW`, `DEFAULT`, `BROWSABLE`, `scheme="https"`, a non-empty host, and
    `pathPrefix="/j/"`.
16. The host in that filter equals the host of the `TAPKART_ORIGIN` used for the
    build (§3, values 1 and 2 agree).
17. `TapkartHceService` is declared with
    `android:permission="android.permission.BIND_NFC_SERVICE"`,
    `android:exported="true"`, the `HOST_APDU_SERVICE` action, and the
    `host_apdu_service` meta-data pointing at `@xml/apduservice`.
18. `apduservice.xml` contains exactly one `aid-filter`, and it is
    `D2760000850101`.
19. Every component with an intent filter has an explicit `android:exported`.
20. `manifest.webmanifest` parses; `name`, `start_url`, `scope`, `display`,
    `icons` present; every icon file exists in `dist/` at its declared size.
21. `dist/sw.js` exists at the root of `dist/`, unhashed.

**By running the artifact:**

22. `apksigner verify --print-certs` on the release APK prints a SHA-256 equal to
    the first entry of `TAPKART_SHA256_FINGERPRINTS` (§3, value 5).
23. The `applicationId` inside the built APK equals `TAPKART_ANDROID_PACKAGE`
    (§3, value 4).
24. The built container, started with a fingerprint variable set, answers
    `GET /.well-known/assetlinks.json` with **HTTP 200**, `Content-Type:
    application/json`, **no redirect** (the request is made without following
    redirects and a 3xx fails the job), and a body that `validateAssetLinks`
    accepts.
25. `docker buildx imagetools inspect` on the pushed tag lists both platforms.

### 10.3 What Playwright adds

The E2E harness itself is Plan 4's (Plan 3 §8.3 assigns it there, since it needs a
server to join). Plan 5 adds specs to it:

26. Load the app, wait for the service worker to control the page, go offline
    (`context.setOffline(true)`), reload, and assert the app shell still renders
    and a solo race can start. **This is a real proof that the offline path
    works**, in a real browser, with a real service worker.
27. Assert `routeRequest`'s `networkOnly` rule end to end: with the worker
    active and the network up, `/.well-known/assetlinks.json` is not in any cache.

§17 Q8 asks who owns the harness if Plan 4 does not build one.

---

## 11. What CI cannot verify — stated plainly, because the spec sets that standard

Spec §8's *What CI cannot verify* names two things and says both are
owner-verified. Spec §2's *Known limits (stated, not hidden)* names four more.
This section is the complete list for Plan 5, and it is written to be *read
against* §10.2: everything mechanical is there, everything below is not.

| Cannot be verified in CI | Why | Nearest thing CI does prove (§10.2) |
|---|---|---|
| **The NFC tap** | HCE needs two physical devices in antenna contact | 1, 4, 13 — both implementations answer every APDU identically |
| **App Links verification** | Android's verifier runs on-device, against the real domain, for the installed certificate | 15, 16, 22, 23, 24 — every input to the verifier is correct and self-consistent |
| **That the deployed origin serves our container** | Cloudflare Tunnel config is the owner's and its hostname is not in the repo | 24 — the container serves it correctly on loopback |
| **That the host's screen stays on / antenna alignment** | Physical | nothing. §6.3 rule 1 is code review only |
| **Android 17+ notification-tap flow** | OS behaviour on an OS version no runner has | nothing |
| **iPhone background reading of an emulated tag** | Spec §2: "good but not universal across models and OS versions" | nothing |
| **That audio sounds like an engine** | Judgement, on a speaker | 9 — the op list is exactly right |
| **That the QR scans** | A camera, a screen, and lighting | 10 — the matrix is structurally valid and stable |
| **That the install prompt appears** | Chrome's engagement heuristics | 20 — the manifest is installable-shaped |
| **How the game feels on a phone** | Spec §8 | nothing |

**This contract does not claim CI proves the NFC tap works. It claims CI proves
the bytes are right.** Those are different sentences and the difference is the
whole point of §5.

### 11.1 The owner verification checklist

Plan 5 ships `docs/owner-verification.md` with a numbered, on-device script. The
list is fixed here so a task cannot quietly shorten it:

1. Install the **release** APK (not debug) on the host phone. Confirm App Links
   verification: `adb shell pm get-app-links <package>` reports `verified` for the
   deployed host.
2. Host a lobby. Confirm the QR and the four-character code are on screen at the
   same time as the tap prompt (spec §2's "always displayed alongside").
3. Tap a **guest without the app**. Confirm the browser opens the lobby (Android
   ≤16) or that a notification appears and opens it (Android 17+).
4. Tap a **guest with the app, foregrounded**. Confirm the join happens in-app
   with no browser.
5. Tap a **guest with the app, backgrounded**. Confirm App Links routes into the
   app, not the browser.
6. Tap with the host's screen **locked**. Confirm nothing happens — this is the
   documented limit, and confirming it is confirming the documentation.
7. Tap with an **iPhone XS or newer**. Record the model and OS version alongside
   the result, because spec §2 says this one is not universal.
8. Airplane-mode the phone, open the installed PWA, confirm it loads and a solo
   race runs.
9. Confirm the engine pitch tracks speed and that item, impact and lap sounds
   fire.
10. Confirm the keystore backup exists, in two places, before the first release
    tag is pushed.

---

## 12. Sole-writer rules

| Thing | Sole writer | Note |
|---|---|---|
| `TagState.ndefFile` | `setNdefUri` | never assigned directly; `createTagState` initialises it to the empty file |
| `TagState.selected` | `processApdu` and `resetTag` | nothing else, in either language |
| `LobbyAdvert.uri` | `TapkartNfcPlugin` | `TapkartHceService` reads it and never writes it |
| `FLAG_KEEP_SCREEN_ON` | `TapkartNfcPlugin.startAdvertising`/`stopAdvertising` | paired; a leak here is a flat battery |
| The `Cache` storage | the service worker's `install`/`activate`/`fetch` handlers | page code never opens `caches` |
| `AudioOpList` | `planAudio` | `createAudioOpList` allocates it once and nothing else assigns `count` |
| The `AudioContext` | `installAudioGate` | `createWebAudioBackend` receives one and never constructs or closes one |
| `<staticRoot>/.well-known/assetlinks.json` | `writeAssetLinks`, at container start | never committed, never edited by hand |
| `manifestPlaceholders["tapkartHost"]` | `apps/android/app/build.gradle`, from `tapkartOrigin` | no other file names a host |
| The signing keystore | the `release` signing config | read by nothing else, in no other job |
| `AudioModel` | Plan 3's `buildAudioModel` | Plan 5 reads it and never writes it — including never clearing `cues` itself |

---

## 13. Files Plan 5 creates, and the exact files it edits outside its own scope

**Creates:** everything under `packages/invite/`, `apps/android/`,
`apps/web/src/pwa/`, `apps/web/src/platform/`, `apps/web/src/sw.ts`,
`apps/web/tools/`, `apps/web/public/manifest.webmanifest`,
`packages/render/src/audio-graph.ts`, `packages/render/src/web/audio.ts`,
`Dockerfile`, `docker/entrypoint.sh`, `docker-compose.yml`,
`.github/workflows/ci.yml`, `.github/workflows/release.yml`,
`docs/owner-verification.md`.

**Edits, and this is the complete list:**

| File | Owner | Edit |
|---|---|---|
| `package.json` (root) | Plan 1 | `workspaces` includes `apps/*`; add `esbuild` devDependency; add `build` and `e2e` scripts |
| `vitest.config.ts` | Plan 1 | `include` gains `apps/*/test/**/*.test.ts` |
| `.gitignore` | Plan 1 | §1's list |
| `README.md` | Plan 1 | keystore generation, backup, and the self-host section (spec §11) |
| `packages/render/package.json` | Plan 3 | `exports["./audio"]` |
| `packages/render/src/index.ts` | Plan 3 | barrel re-exports `audio-graph` (not `web/audio`) |
| `packages/game/package.json` | Plan 3 | dependency on `@tapkart/invite` — **only if §17 Q4 is ruled that way** |
| `packages/game/src/shell.ts` | Plan 3 | `ShellOptions.nfc: NfcHost \| null` — **same ruling** |
| `apps/web/index.html` | Plan 3 | manifest link, `theme-color` meta |
| `apps/web/src/main.ts` | Plan 3 | SW registration, install/update wiring, audio gate, `NfcHost` selection |
| `apps/web/vite.config.ts` | Plan 3 | `build.manifest = true` |
| `apps/web/package.json` | Plan 3 | dependency on `@tapkart/invite`; build script chains `tools/build-sw.mjs` |

Two of the twelve are conditional on a single ruling. If Q4 is ruled the other
way, `apps/web` drives NFC itself and `packages/game` is untouched — at the cost
of `apps/web` needing a hook into screen transitions that Plan 3's `GameShell`
(`{ stop(): void }`) does not currently provide.

---

## 14. Exported-symbol census

| Module | Count |
|---|---|
| `invite/hex` | 2 |
| `invite/uri` | 6 |
| `invite/invite` | 5 |
| `invite/t4t` | 14 |
| `invite/reader` | 7 |
| `invite/host` | 3 |
| `invite/applinks` | 9 |
| `invite/qr` | 5 |
| **`packages/invite` subtotal** | **51** |
| `render/audio-graph` | 11 |
| `render/web/audio` | 4 |
| **`packages/render` additions subtotal** | **15** |
| `web/pwa/policy` | 7 |
| `web/pwa/install` | 5 |
| `web/pwa/update` | 4 |
| `web/platform/env` | 3 |
| `web/platform/nfc` | 2 |
| `web/platform/audio` | 2 |
| `web/tools/precache` + `web/tools/png` + `write-assetlinks` | 5 |
| **`apps/web` subtotal** | **28** |
| Kotlin `nfc/Hex` (object + 2 fns), `nfc/NdefUri` (object + const + 3 fns) | 8 |
| Kotlin `nfc/T4tTag` (class, enum, property, 3 fns, 4 companion members) | 10 |
| Kotlin `nfc/LobbyAdvert` (object, property, 2 fns, 2 consts) | 6 |
| Kotlin `nfc/TapkartHceService` (class + 2 overrides), `nfc/InviteReader` (object + fn) | 5 |
| Kotlin `TapkartNfcPlugin` (class + 5 `@PluginMethod` + 2 lifecycle), `MainActivity` | 9 |
| **`apps/android` subtotal** | **38** |
| **Total** | **132** (94 TypeScript, 38 Kotlin) |

Plus two fixture files (§5.7) and the declaration files of §6.2, §7.1, §9 and
§10.1, which export nothing and are checked structurally.

---

## 15. What Plan 5 deliberately does not build

- **No iOS app.** Spec §1 puts it out of scope; spec §2 relies on iOS *background
  tag reading*, which is an OS feature requiring nothing from us.
- **No Play Store listing, no App Bundle, no signing-key upload to Google.**
  Spec §9: GitHub Release asset.
- **No Web NFC (`NDEFReader`).** Spec §2 rules it out in its first bullet: it
  reads and writes physical tags and has no peer-to-peer mode.
- **No `ACTION_NDEF_DISCOVERED` intent filter** unless §17 Q16 rules otherwise.
  Spec §2 is explicit that it will not catch our own URL on Android 16+.
- **No push notifications, no analytics, no crash reporting, no telemetry.**
- **No background sync and no offline multiplayer.** Offline means the installed
  app opens and a solo race runs against bots; a lobby needs a server.
- **No TURN/coturn.** Spec §3: STUN only, with the server-relay fallback, and
  that is Plan 4's.
- **No changes to `sim`, `protocol` or `net`.** If Plan 5 appears to need one,
  the seam is in the wrong place.

---

## 16. The failure this contract is written to prevent

Plan 2's contract needed twelve amendments during authoring, each costing roughly
two blocking defects at audit. The four highest-risk shared names in Plan 5,
ranked by how many independent authors have to agree on them:

1. **The five values of §3.** Five files, four languages, one wrong host, and the
   result is an app that *works* — it just opens in the browser instead, silently,
   forever, on every Android 12 or newer device. No test fails. The mitigation is
   that all five derive from `TAPKART_ORIGIN` and the keystore, and that §10.2's
   assertions 15, 16, 22, 23 and 24 chain them together.
2. **`CC_FILE` and the status-word table (§5.2, §5.4).** Written twice, in two
   languages, by two authors. A single wrong byte in the CC makes every reader
   give up before it ever asks for the NDEF file, and the symptom is "the tap does
   nothing" — indistinguishable from bad antenna alignment. The shared fixture is
   the only thing standing between those two diagnoses.
3. **`resetTag` on `onDeactivated` (§5.5).** Omit it and the *first* tap of the
   day works perfectly, which is exactly the profile of a bug that ships.
4. **The pure/adapter seam in three new places** — `sw.ts`, `web/audio.ts`, the
   Kotlin services. Plan 3 §8.2 established that one adapter import in a barrel
   breaks the entire headless suite with an error pointing at the wrong package;
   `three` was that risk, `AudioContext` and `android.*` are this plan's.

---

## 17. Open questions for the controller

Every item is a place this draft guessed, a place the spec admits two readings, or
a place two tasks would produce different code. Each one ruled now is an amendment
avoided.

### Scope and ownership

**Q1. Package name: `@tapkart/invite` or `@tapkart/nfc`?** The draft chose
`invite` because the package owns tap, QR and typed-code alike, and because
`applinks.ts` and `qr.ts` are not NFC. Against it: every reader looking for the
NFC code will search for "nfc" first. A third option is two packages
(`@tapkart/nfc` + `@tapkart/invite`), which the draft rejects as ceremony — the
combined surface is 51 symbols.

**Q2. Does the QR encoder belong to Plan 5 at all, and is it written or
depended-on?** Spec §2 and §11 require QR unconditionally; it appears in no other
plan's contract. This draft claims it and specifies `buildQrMatrix` as a pure
function. Two sub-questions: (a) confirm Plan 5 owns it; (b) hand-write a byte-mode
ECC-M encoder (Reed–Solomon over GF(256), masking, format info — several hundred
lines of well-specified, well-testable code, no dependency) or pin a small
zero-dependency library and wrap it behind `buildQrMatrix`? This repo currently
has exactly one runtime dependency in total (`three`).

**Q3. May Plan 5 write into `packages/render`?** The draft puts `audio-graph.ts`
and `web/audio.ts` there and adds an `exports["./audio"]` entry and a barrel line —
two edits to Plan 3 files. Rulings Q26 says Plan 5 "adds a Web Audio implementation
and touches nothing else" without saying where it lands. The alternative is
`apps/web/src/audio/`, which touches no Plan 3 file but separates the planner from
the `AudioModel` it plans from and puts a heavily-tested pure module inside an app.

**Q4. May Plan 5 add `nfc: NfcHost | null` to Plan 3's `ShellOptions`, and may
`@tapkart/game` depend on `@tapkart/invite`?** The lobby screen is `game`'s, and
something has to call `advertise(uri)` when it opens and `stop()` when it closes.
`@tapkart/invite` is pure and zero-dependency, so it does not endanger headless
tests. The alternative is a new hook on `GameShell` so `apps/web` can observe
screen transitions — which is a bigger change to a smaller file.

**Q5. Does `AppState` need an `inviteUri`, or is it derived?** The draft derives:
`buildInviteUri(TAPKART_ORIGIN, state.roomCode)`. That works only if the origin is
build-time (Q11) and the room code is authoritative in `AppState` (Plan 3 §5.9 says
it is). If the server ever returns a full URL, the derived version is a second
source of truth.

**Q6. Are `apps/*` already in `workspaces`, and is `apps/*/test/**` already in the
vitest `include`?** Plan 3 creates `apps/web` and it must be a workspace member for
`@tapkart/game` to resolve by bare specifier. If Plan 3 did it, §13's first two
rows disappear. If not, Plan 5 does it — and every Plan 3 task that assumed
otherwise was typechecking nothing.

**Q7. What is Plan 4's server actually called, how is it built, and how does it
learn its static root?** The Dockerfile needs a build command, a start command, a
static-root mechanism and a health path. All four are guesses right now.

**Q8. Does Plan 4 create the Playwright harness?** Plan 3 §8.3 assigns E2E to
Plan 4. If it did not, Plan 5 creates `playwright.config.ts` and the whole lane,
which is materially more work than adding two specs.

### Android project shape

**Q9. `apps/android` with `android: { path: '.' }`, or the default nested
`apps/android/android/`?** The draft flattens it so Gradle files sit directly in
`apps/android`. If the pinned Capacitor version does not honour `android.path`,
the nested layout is the fallback and every path in §6.1 and §10.2 shifts by one
directory.

**Q10. Does the APK bundle the web build, or point a WebView at the deployed
origin?** The draft bundles (offline works, `cap sync` copies `apps/web/dist`).
Pointing at the origin via `server.url` would make the app always-current and make
`location.origin` correct for free — at the cost of the offline requirement and of
a WebView that is useless without network.

**Q11. Is `TAPKART_ORIGIN` build-time or runtime?** The draft bakes it into both
the APK (Gradle placeholder) and the bundle (`VITE_TAPKART_ORIGIN`), which means a
self-hoster on a different domain must rebuild both. A runtime-configurable origin
would let the container serve any domain — but the Android intent filter is
compiled into the APK and can never be runtime-configurable, so the two halves
would then disagree. The draft treats "one build per domain" as the honest
consequence of App Links. Confirm.

**Q12. `applicationId = io.github.atvriders.tapkart`?** It embeds the GitHub org,
which is already public in the spec's first line. Alternatives: `com.tapkart.game`
(claims a domain we do not own) or `dev.tapkart.app` (same problem).

**Q13. Invite path `/j/`.** Short, so the NDEF record stays small. Does it collide
with any route Plan 4 plans (`/join`, `/api/*`, `/signal`)? And are room codes
upper-case-only in the URL, so `pathPrefix` matching and `normalizeRoomCode` agree?

**Q14. Should the invite URI carry anything besides the room code** — a protocol
version, the host's name, a nonce? Each byte costs NDEF size (harmless) but every
extra parameter is another thing `parseInviteUri` can reject and another reason a
verified App Link might not match its `pathPrefix`.

**Q15. `requireDeviceUnlock="true"` or `"false"`?** The draft says `true`, matching
spec §2's stated limit. `false` would let a locked-but-awake host still answer,
which is strictly more taps that work — and would make the spec's Known-limits
paragraph wrong, and the owner-verification step 6 assert the opposite of what it
asserts now.

**Q16. Add an `ACTION_NDEF_DISCOVERED` intent filter as well?** Spec §2 says it
"will not catch our own lobby URL on current Android", which is a statement about
Android 16+, not about Android 15 and earlier. Adding it costs four lines and
catches the app-installed case on older devices; leaving it out keeps exactly one
route into the app and one thing to debug.

**Q17. `setPreferredService` while the lobby is open** — confirm. It requires the
activity reference and a `ComponentName`, and it is the only defence against
another installed app claiming the same AID.

### The APDU layer

**Q18. The CC values: MLe `0x00F6`, MLc `0x00FF`, max NDEF file size `0x0400`,
write access denied.** All four are pinned into a fixture that two languages
compare against, so they are cheap now and expensive later.

**Q19. Over-read: truncate and return `90 00`, or return `6C XX`?** The draft
truncates. Android's reader never over-reads, so this only affects readers we do
not target.

**Q20. The §5.4 status-word table, and the TSV fixture format instead of JSON.**
Both are pure convention; both are copied into Kotlin. The JSON alternative needs
Gson or kotlinx-serialization on the Android unit-test classpath, because
`org.json` is stubbed there.

**Q21. Non-advertising state serves an empty NDEF file (`00 00`) rather than
refusing SELECT.** Confirm.

**Q22. No Android Application Record.** Confirm — an AAR would send an
app-less guest to a Play Store page for an app that is not on the Play Store.

**Q23. When is the guest's reader mode on?** The draft says only while a screen
that can act on a tap is foregrounded, off in `handleOnPause`. Always-on would
catch a tap on the results screen; it would also intercept every transit card the
phone touches while the app is open.

### PWA and audio

**Q24. `display: fullscreen` + `orientation: landscape`.** Does the game support
portrait at all? Plan 3's control schemes (thumb zones, 88 pt buttons at fixed
insets) read as landscape-only, but nothing says so.

**Q25. Never auto-`skipWaiting`; the update lands after the results screen or on
the next cold load.** The cost is that a player can stay on a stale build for a
whole session. The alternative swaps the bundle under a running authority loop.

**Q26. Offline scope.** The draft: the installed app opens offline and a solo race
against bots runs. Is offline solo a *requirement* (and therefore an E2E
assertion, §10.3 item 26) or a nice-to-have that must not fail the build?

**Q27. Icons generated at build time by a hand-rolled PNG encoder, into a
gitignored directory.** The alternative is committing three PNGs, which is three
binaries in a public repo and no test that they match the manifest.

**Q28. The `ONE_SHOT_SPECS` table is the entire sound design of the game, as
data, and this draft does not fill in a single number.** Who tunes it — is the
first pass authored blind and tuned by the owner on a device (like the track
palettes), or is it a delegation candidate under spec §10?

**Q29. `WebAudioBackend = AudioBackend & { setConfig }`.** The seam has exactly two
methods and `AudioModel` carries no volume, so a live settings change has nowhere
to go. The draft widens the concrete type. The alternatives are adding
`masterGain`/`enabled` to `AudioModel` (a Plan 3 amendment, and it makes the
*model* carry a user preference) or recreating the backend on every volume change
(an audible gap).

**Q30. `esbuild` as an explicit root devDependency**, used to bundle
`write-assetlinks.ts` for the container and available for any other TS tool. It is
already present transitively through Vite; the draft insists on declaring it,
since relying on a transitive binary is how a Vite major bump breaks the deploy.

### Versions and CI

**Q31. The version pins.** Capacitor major (spec §9: "pinned in `package.json`"),
AGP, Gradle, `compileSdk`, `minSdk`, `targetSdk`, and the Kotlin plugin. The draft
deliberately does not invent numbers: it says the Capacitor template's values are
used unmodified except that `targetSdk` must be at least the Android 16 API level,
since spec §2's entire argument is about Android 16 behaviour. Which exact values,
and does `minSdk` need to move for HCE (API 19) or for Capacitor?

**Q32. Node 20 in CI** (the root `engines` says `>=20`) alongside **JDK 21** for
Android (spec §9). Confirm, and confirm the Android job runs `npm ci` at the root
first — it must, because `cap sync` needs `apps/web/dist`.

**Q33. Release trigger and tag shape: `v*`.** Every tag builds and pushes the
image and uploads an APK. Does `main`/`master` also push a `latest` image, or is
`latest` tag-only? (A `latest` that moves on every commit is a different deploy
story than one that moves on releases.)

**Q34. Image tags:** `latest`, the version, and the commit SHA? And is the
`container` smoke-test job (§10.1) gating, or informational?

**Q35. `TAPKART_SHA256_FINGERPRINTS` as a repo *variable*, not a secret.** A
signing certificate fingerprint is public by design — it is published in
`assetlinks.json` for the world to read — but §1 forbids it in a repo *file*. A
variable is not a file. Confirm that reading is right, and confirm CI may echo it
into a generated `assetlinks.json` inside a container it then curls.

**Q36. Does the debug-build fingerprint get a second slot in
`TAPKART_SHA256_FINGERPRINTS`?** Spec §2 explicitly permits it ("so a locally-built
debug APK also verifies during development"). It is the owner's machine's debug
certificate, so it can only ever be set by the owner, locally.

**Q37. `writeAssetLinks` behaviour when the env is unset: skip and exit 0.** So a
self-hoster with no APK gets a working server and no 404-shaped confusion. Set but
malformed: exit 1. Confirm both.

**Q38. Who guarantees "no redirect" on `/.well-known/assetlinks.json`?** Spec §2
and §9 both demand it. The container test proves the *container* does it. The
tunnel, the reverse proxy and any HSTS/trailing-slash normalisation in Plan 4's
static handler are all outside that proof. Should Plan 5 additionally ship a
one-line documented `curl -I` check in `docs/owner-verification.md` (the draft
assumes yes, as step 1's companion)?

**Q39. Compose: `3031:3031`, env var names as §9.2.** Confirm the four names, since
Plan 4's server will read `PORT` and possibly `TAPKART_ORIGIN` too, and two plans
inventing two names for the origin is exactly the §3 failure.

**Q40. `docs/owner-verification.md` and the README keystore section are Plan 5
deliverables.** Spec §11 says the keystore backup is "documented in the repo
README", so the README edit is spec-mandated; the checklist file is this draft's
proposal.

### Repo-wide

**Q41. `tsconfig` `lib` settings.** `tsconfig.base.json` has `"lib": ["ES2022"]`
with no DOM. Plan 3's `shell.ts` names `HTMLCanvasElement` and its
`three/renderer.ts` names it too, so `packages/render`, `packages/game` and
`apps/web` all need `"lib": ["ES2022", "DOM", "DOM.Iterable"]`, and `apps/web/src/sw.ts`
needs `WebWorker` — which conflicts with `DOM` over the type of `self`. The draft
pins the `const sw = self as unknown as ServiceWorkerGlobalScope` idiom with a
single `/// <reference lib="webworker" />`. **Is this Plan 3's problem or Plan 5's?**
If Plan 3 ships without touching `lib`, its typecheck cannot have passed, which
would be worth knowing before Plan 5 starts.

**Q42. The no-secrets grep test (§1) reads the repository.** It is the only test
that does. Acceptable, or does it belong in CI as a shell step instead?

**Q43. Placeholder host `tapkart.example`.** RFC 2606 reserves the `.example` TLD,
so it can never resolve — which is exactly right for a value nobody should
accidentally deploy against.

**Q44. Is there anything to build for iOS at all?** Spec §2's iPhone row is pure
OS behaviour: background tag reading finds any Type 4 tag with a URI record and
offers a banner. The draft ships nothing for it and asserts nothing about it. If
that is wrong, it is wrong now, before the NDEF record shape is frozen in a
fixture.

**Q45. Does the host need to keep advertising while the app is backgrounded?** HCE
answers from a background service, so a backgrounded host is still tappable if
`LobbyAdvert.uri` is still set. The draft leaves the advert set until
`stopAdvertising`, which means a host who switches apps mid-lobby stays tappable —
but `FLAG_KEEP_SCREEN_ON` no longer applies and the screen will sleep. Clear the
advert on pause, or leave it?

**Q46. What happens to a guest who taps and lands on the lobby URL of an expired
room?** Spec §5 says rooms expire. The web app has to show something specific;
this draft does not define it, and it is the single most likely thing a real user
will hit at 2am the day after a session.

**Q47. `SwRequestInfo` is a plain struct, not a `Request`,** so the SW policy tests
need no DOM types and honour Plan 3 rulings Q30's "`node` everywhere, no jsdom, no
per-file override". Confirm that reading — the alternative (typing against
`Request`) would pull DOM types into a pure module and make the seam meaningless.
