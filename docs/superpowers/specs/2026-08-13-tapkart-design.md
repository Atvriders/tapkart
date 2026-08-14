# Tapkart — Design

**Date:** 2026-08-13
**Status:** Approved design, revised after adversarial review, pre-implementation
**Repo:** `Atvriders/tapkart` (public)

---

## 1. What this is

Tapkart is a mobile browser kart racer. Players pick a character, race three
laps against up to seven others, drift for boost, and throw items. Friends join
a lobby by tapping their phone to the host's phone.

The game ships as one TypeScript codebase producing two artifacts:

- a **browser PWA**, served from a Docker image, playable on any phone or desktop
- an **Android APK** (Capacitor) whose only added capability is NFC

Only the host needs the APK. Everyone else joins by tap, QR, or a four-character
room code.

### Scope of v1

| Dimension | v1 |
|---|---|
| Racers per race | 8 (humans fill slots, bots fill the rest) |
| Characters | 8 |
| Tracks | 6 |
| Laps | 3 |
| Items | 8 types |
| Control schemes | 3, selectable (plus keyboard for desktop) |
| Platforms | Browser (all), Android APK (NFC host) |

Explicitly out of scope for v1: iOS app, licensed music, online matchmaking
beyond a room code, persistent accounts, cups/championships, ranked play.

---

## 2. The NFC decision

The original ask was to tap two phones together to open the invite link. The
honest constraints:

- **Web NFC (`NDEFReader`) cannot do this.** It is Chrome-on-Android only, and
  it only reads and writes physical NFC tags. There is no peer-to-peer mode.
- **Android Beam is gone.** NDEF push was deprecated in Android 10 and removed.
  Its OS-level replacements (Nearby Share, AirDrop/NameDrop) are unreachable
  from a web page.

What does work, and is what we build:

**The host's Android app emulates an NFC tag.** Using Host Card Emulation, the
app registers a `HostApduService` for the NDEF Type 4 application ID
`D2760000850101`, serving a capability container and an NDEF file containing the
lobby URI. To any reader, the host's phone looks like an NFC Forum Type 4 tag
holding a URL.

### What a guest actually experiences

| Guest device | What happens |
|---|---|
| Android 15 or earlier, no app | NDEF dispatch opens the lobby URL in the browser |
| Android 16, no app | Tag fires `ACTION_VIEW`; the lobby URL opens in the browser |
| Android 17+, no app | Tag surfaces an **"open link" notification**; the guest taps it, then the browser opens |
| Android, with APK, app foregrounded | Reader mode intercepts the tag and joins in-app immediately |
| Android, with APK, app backgrounded | App Links routes the verified URL into the app (see below) |
| iPhone XS or newer | Background tag reading shows a banner that opens Safari at the lobby |

### App Links is mandatory, not polish

From **Android 16**, scanning an NDEF tag whose URI scheme is `http`/`https`
fires `ACTION_VIEW` rather than `ACTION_NDEF_DISCOVERED`. An
`ACTION_NDEF_DISCOVERED` intent filter therefore will not catch our own lobby
URL on current Android. Android App Links is the supported path, and it has hard
preconditions:

- `android:autoVerify="true"` on an `ACTION_VIEW` intent filter for the lobby
  path.
- `/.well-known/assetlinks.json` served over HTTPS, `Content-Type:
  application/json`, **no redirects**.
- `sha256_cert_fingerprints` matching the certificate that actually signed the
  installed APK.

That last point kills debug signing. Gradle auto-generates
`~/.android/debug.keystore` when absent, and a GitHub Actions runner is a fresh
VM every run, so **every CI build would carry a different certificate** and no
static `assetlinks.json` could ever match. Worse, on Android 12+ a failed
verification is silent — no disambiguation chooser, the link just opens in the
browser.

**Therefore v1 signs with a stable keystore from the first build**: generated
once, stored base64 in repo secrets with its passwords, its SHA-256 published in
`assetlinks.json`. The keystore is backed up the day it is created. This is a
day-one requirement, not a v2 migration.

The `assetlinks.json` may list multiple fingerprints so a locally-built debug
APK also verifies during development.

### Known limits (stated, not hidden)

- The host's screen must be on and unlocked for HCE to respond.
- The phones must make antenna contact. On most Androids the antenna is in the
  upper back, not the middle.
- On Android 17+ the guest taps a notification rather than landing in the lobby
  directly. The tap is still the invite; it is one confirmation longer.
- iPhone background reading of *emulated* tags is good but not universal across
  models and OS versions.

Because of those last two, **QR and a four-character room code are always
displayed alongside** the NFC invite. Nobody is ever blocked from joining.

---

## 3. Architecture

npm-workspaces monorepo, TypeScript throughout.

```
packages/
  sim/        pure TS, zero deps, no DOM, no Three.js
              fixed-60Hz kart physics, world entities, items, AI,
              lap and placement rules
  protocol/   message types + WireSnapshot codec + AuthorityCheckpoint codec
  net/        transports (WebRTC, WebSocket, Loopback)
              + AuthorityLoop / ShadowLoop / ClientLoop
  render/     Three.js scene, track mesh generation, instanced karts,
              entity VFX, camera, parametric character/kart meshes
  game/       screens (title, character select, lobby, race, results)
              + input adapters
apps/
  web/        Vite -> static PWA, Dockerfile -> GHCR
  android/    Capacitor project + Java NFC plugin
server/       static serving, signaling, room registry, shadow authority
```

### Three load-bearing decisions

**`sim` is pure and imports nothing.** The same module runs in four places — the
host phone's authority loop, every client's prediction loop, the server's shadow
loop, and headless tests. There is exactly one definition of what the game does.

"Pure" here means deterministic and free of external side effects, not
allocation-free-by-magic: `step(prev, next, inputs, tick)` writes into a
caller-owned `next` buffer, and the loops double-buffer. No wall-clock reads, no
`Math.random()`, no I/O.

**Tracks are data, not models.** A track is a centerline spline (Catmull-Rom
control points) plus width profile, banking, surface segments, ramps, boost
pads, item-box positions, shortcut branches, and a checkpoint ring. `render`
generates the mesh from it; `sim` derives ground height, surface type,
containment, respawn, and lap validation analytically from the same spline. The
collision surface cannot drift from what the player sees, because there is only
one description of the track. A track is a JSON file.

The same principle covers characters and karts: parametric low-poly meshes built
in `render` from JSON descriptors. Eight characters is eight JSON files, not
eight modeled assets.

**Two distinct state objects, never conflated.** This was the single biggest
defect found in review, so it is named explicitly here and used consistently
throughout:

| Object | Fidelity | Lives | Used for |
|---|---|---|---|
| `SimState` | full float64 | in memory | the authoritative simulation |
| `SimCheckpoint` | full float64, structurally cloned | in memory, and on the reliable channel as `AuthorityCheckpoint` | reconciliation rewind, late-join, resync |
| `WireSnapshot` | quantized, ~21 B/kart | unreliable channel | remote-kart interpolation and correction |

`WireSnapshot` is lossy by construction. It is **never** a resume point for an
exact replay, and no test asserts bit-identity across it.

### Dependency direction

`sim` and `protocol` depend on nothing and on each other not at all. `net`
depends on both. `game` depends on `net`, `render`, and `sim`. `render` reads
`sim` types and track geometry but never mutates simulation state. `server`
depends on `sim`, `protocol`, and `net`.

### Infrastructure choices

- **STUN only, no coturn.** Symmetric NAT that defeats STUN falls through to the
  server-relay path (section 5), which is the same code over a different
  transport.
- Server runs Node, serves the static PWA, holds the room registry, performs
  WebRTC signaling, and runs a **shadow authority** per active room.

---

## 4. Simulation

All of this lives in `packages/sim`.

### Tick model

Fixed 60Hz integer ticks:

```
step(prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[], tick: number): void
```

Deterministic and side-effect free. Reconciliation depends on this; nothing else
in the design works without it.

### Input intent

Every input source — touch zones, tilt, virtual stick, keyboard, and the AI
bots — produces the same struct:

```
{ tick, steer: -1..1, accel: 0..1, brake: bool, drift: bool, useItem: bool }
```

Bots are not special-cased anywhere in the simulation. They are an intent
producer, like a thumb.

### `SimState`

**Per kart:** position, velocity, heading, angular velocity, drift
`{active, dir, charge}`, held item, airborne flag, current surface, spin-out
timer, invulnerability timer, lap progress `(lap, checkpointIdx, t)`, and
connection/bot flags.

**World entities** (added in review — six of the eight items create state that is
neither a kart nor a discrete event):

```
{ entityId, kind, ownerId, position, velocity, targetId, ttl, ...perKind }
```

`kind` covers seeker, bolt, slick, bubble, surge field, and charge blast. Entity
IDs are allocated by the authority from a monotonic counter. Cap: 32 live
entities per race.

**World:** per-item-box respawn timers, race phase, race tick, and the PRNG
cursor (draw count consumed so far).

### Handling model

Arcade, not rigid-body:

- Longitudinal force toward a character-scaled target speed.
- Yaw rate proportional to steer input times a speed-dependent curve, so the
  kart does not pivot in place at low speed.
- Lateral velocity damped hard on tarmac, loosely on dirt, and deliberately
  retained while drifting.
- Gravity plus analytic ground height from the spline. No mesh raycasts.
- Ramps launch the kart when the surface angle breaks sharply. Airborne removes
  steering authority except for a small air-yaw.
- Off-track applies a speed multiplier; out-of-bounds triggers a 1.2s respawn to
  the last checkpoint with brief invulnerability.
- Kart-vs-kart is sphere collision with equal-and-opposite impulse weighted by
  weight class.

### Drift and mini-turbo

Drift latches a slide direction while held. Charge accrues in three tiers,
releasing a short, medium, or long boost on release. This is the mechanic the
entire game feel rests on; it gets its own tuning table and its own
golden-replay tests.

### Items

| Item | Effect | Creates entity |
|---|---|---|
| Boost | Immediate speed burst | no |
| Seeker | Homing projectile, targets the kart ahead | yes |
| Bolt | Straight-fired projectile, physics-driven | yes |
| Slick | Dropped persistent hazard, spins out on contact | yes |
| Bubble | Orbiting shield, absorbs one hit | yes |
| Surge | Timed field-wide slow on everyone ahead | yes |
| Blink | Brief invulnerability plus speed | no |
| Charge | Area blast | yes |

Distribution is weighted by race position, so last place draws the strong items.

**Item rolls happen only on the leader authority**, from a per-race seeded PRNG
whose cursor is part of `SimState`, and reach clients as events. Clients and the
shadow authority never roll; they apply granted items as authoritative events.
Clients never predict what an item box yields, because a mispredicted item is a
visible pop. Everything else about the local kart is predicted.

Entities are **authority-simulated and client-interpolated only, never
predicted** — the same rule already applied to remote karts. A client cannot
predict a seeker's homing because it only holds ~100ms-stale positions for the
karts the seeker is chasing.

### Laps and placement

A checkpoint ring must be crossed in order. `(lap, checkpointIdx, t)` sorts
directly into a race position. This eliminates backwards-driving exploits and
accidental shortcut cheese, while still allowing *designed* shortcuts to count
because they rejoin the checkpoint ring in order.

### Bots

Bots follow the centerline with a per-bot lateral bias and noise, rubber-band
their target speed toward the leading human's progress, and use items on simple
heuristics. They fill the grid to eight, and they are what makes the game
playable the moment it opens, before anyone has tapped a phone.

---

## 5. Netcode and session lifecycle

Model: **host-authoritative peer-to-peer with client-side prediction and
reconciliation**, plus a **server shadow authority** that is promoted on host
loss.

### Transports

One interface, three implementations:

- `WebRTCTransport` — default, host to peers
- `WebSocketTransport` — server relay, shadow feed, and post-promotion authority
- `LoopbackTransport` — tests, with injectable latency, jitter, and loss

Each exposes two channels: **unreliable-unordered** for input and wire
snapshots, **reliable-ordered** for events, checkpoints, and lobby state.
Nothing above the transport layer knows which implementation is in use.

### Client to authority

Input intents at 30Hz, each datagram carrying the last 8 intents. Redundancy is
free at this size, so a dropped packet costs nothing. Because the sim runs at
60Hz and input arrives at 30Hz, **the authority holds the newest intent and
applies it to both ticks of the pair**, repeating the last known intent across
gaps. Drift timing is quantized to 2 ticks (33ms) as a result; the mini-turbo
tier thresholds are defined in multiples of 2 ticks so a tier boundary can never
fall inside an unobservable window.

Every client sends its input to **both** the host and the server shadow. That is
2 KB/s up per client, and it is what makes promotion near-instant.

### Authority to clients — `WireSnapshot` at 20Hz

Per-kart record, bit-packed:

| Field | Bits |
|---|---|
| position x, y, z | 3 × 16 |
| velocity x, y, z | 3 × 12 |
| heading | 12 |
| angular velocity | 10 |
| drift charge | 8 |
| drift active + dir | 2 |
| airborne | 1 |
| surface | 2 |
| spin-out timer | 8 |
| invulnerability timer | 8 |
| held item | 4 |
| lap | 3 |
| checkpoint index | 6 |
| t along segment | 10 |
| player id | 3 |
| bot/connected flags | 1 |
| **total** | **162 bits ≈ 21 B** |

**Invariant:** the per-kart record is a complete projection of every field in
`SimState`'s kart struct. A field absent from this table cannot exist in the
kart struct.

Entity record: `{entityId u16, kind u4, ownerId u3, position 3×u16, packed
velocity/heading u16, ttl u8}` ≈ 12 B. Typically 0–6 live, capped at 32.

Header: `tick u32`, `eventSeq u32`, per-player `lastProcessedInputTick` (8 ×
u16), entity count u8 ≈ 25 B.

**Bandwidth, recomputed honestly:**

| | Typical (6 entities) | Worst case (32 entities) |
|---|---|---|
| Snapshot size | ~265 B | ~610 B |
| Down per client @20Hz | ~5.3 KB/s | ~12 KB/s |
| Host up (8 peers + shadow) | ~48 KB/s | ~110 KB/s |

Comfortable on wifi and LTE. Delta encoding against the last acked snapshot is
an available optimization if the worst case proves tight; v1 ships uncompressed.

### Prediction and reconciliation

The client runs `step()` locally at 60Hz on its own input immediately and keeps
a ring buffer of `(tick, input, SimCheckpoint)` — full precision, in memory.

When a `WireSnapshot` arrives, the client dequantizes the authoritative state
for its own kart at `lastProcessedInputTick` and compares. If any field differs
by more than its **per-field epsilon**, the client resets to the authoritative
value and replays every buffered input forward to the present frame. At 100ms
RTT that is 6–10 ticks of a cheap arcade simulation — well under a millisecond.

Each epsilon is derived from, and must exceed, that field's quantization step —
otherwise quantization noise alone triggers a correction every single snapshot
and the kart visibly buzzes. The epsilon constants and the quantization
constants live together in `protocol` and are asserted against each other in
tests.

Remote karts and all world entities are not predicted. They are buffered and
rendered approximately 100ms in the past with interpolation, extrapolating
briefly and with a hard cap when the buffer starves.

### Events

Item grants, entity spawns and despawns, hits, spin-outs, and lap crossings
travel the reliable channel carrying a **global monotonic `eventSeq`** assigned
by the current authority. Clients apply each event once and ignore any
`eventSeq` at or below the highest already applied — which is what makes
migration safe.

The local kart's hit reaction plays on receipt, not on prediction. The resulting
small delay reads far better than a dodged shell rewinding into the player's
face.

### The server is a shadow authority

The server does not sit passively holding snapshots — review established that a
passive server cannot reconstruct a valid state at all (no PRNG cursor, no
entity state, no input buffers, no event sequence). Instead:

**Follower mode (normal).** The server receives every client's input stream and
the host's authoritative events, and runs `step()` in lockstep. It never rolls
items and never originates events; granted items arrive as events. It uses the
host's `WireSnapshot` stream as a periodic correction, exactly as a client does
for its own kart, but across all karts and entities.

**Promotion.** Host loss is declared after **1.5s with no snapshot** (30 missed
at 20Hz). The server broadcasts `authorityChange {tick, eventSeq}` on the
reliable channel and switches to leader mode: it begins rolling items from a
PRNG re-seeded deterministically from `(raceSeed, promotionTick)`, and continues
`eventSeq` from the highest it observed. Clients swap transports and keep their
existing tick baseline, because the shadow has been ticking alongside all along.

Because the shadow has been simulating continuously, there is no rewind: no kart
teleports backward, no lap counter rewinds, no in-flight projectile vanishes.
Expect a visible hitch of a few hundred milliseconds while transports swap.

**Accepted divergence:** post-promotion item rolls differ from what the original
host would have produced. This is unobservable to players and is accepted.

**Cost:** the server runs one 60Hz arcade sim per active room. This bounds room
capacity per server process and is a known, measured constraint rather than a
surprise.

### `AuthorityCheckpoint`

A full-precision serialization of `SimState` — every kart field, every entity,
item-box timers, PRNG cursor, race phase, tick, and `eventSeq` — sent on the
reliable channel. Used for late join, for a client whose reconciliation has
diverged past recovery, and for shadow resync after a network partition. Not
sent periodically in the steady state.

### Other failure handling

- **WebRTC never establishes** for a guest (symmetric NAT, no TURN): that guest
  attaches over WebSocket and the server relays between them and the host.
- A client that drops has its kart taken over by a bot so the race stays intact,
  and reclaims it on reconnect with the same room code.
- A client whose reconciliation diverges repeatedly is sent an
  `AuthorityCheckpoint` and hard-resynced, and the event is logged.
- Rooms expire after a period of inactivity.

### Session lifecycle

1. Host creates a room. Server mints a four-character code and a URL, and starts
   a shadow loop.
2. Host advertises the URL over HCE, and displays the QR code and the room code.
3. Guest arrives by tap, scan, or typed code and hits the signaling endpoint.
4. Offer/answer exchange through the server; DataChannel comes up. The guest's
   WebSocket to the server stays open for the shadow input feed.
5. Lobby, character select, and countdown ride the reliable channel.
6. Race runs on the unreliable channel with events on the reliable one.
7. Results screen, then back to the lobby with the room intact.

---

## 6. Controls

Three schemes, selectable in settings, all normalizing to the same intent
struct:

**Auto-accelerate + thumb zones (default).** The kart always accelerates. The
left half of the screen steers by drag; the right half holds drift and item
buttons. No gas pedal to hold means a thumb stays free for drift.

**Tilt.** Steering by device orientation, buttons for drift and item. Requires a
calibration flow and, on iOS, an explicit motion-permission prompt. Offered, not
default.

**Virtual stick + pedals.** On-screen stick plus explicit gas, brake, drift, and
item buttons. Most control, most screen occlusion.

**Keyboard** is always available on desktop for development and testing.

Because every scheme reduces to the same intent struct — the same one the bots
and the netcode use — three schemes is three small adapters, not three control
systems.

---

## 7. Content

| Asset | Form | Count |
|---|---|---|
| Tracks | JSON spline + segment metadata | 6 |
| Characters | JSON descriptor -> parametric mesh | 8 |
| Karts | JSON descriptor -> parametric mesh | 8 |
| Items | Tuning table + procedural VFX | 8 |
| Audio | Procedural Web Audio | n/a |

Audio in v1 is procedural: engine tone pitched by speed, skid, impacts, item
stings. No licensed music, with a hook to add real tracks later.

---

## 8. Testing

| Layer | Approach |
|---|---|
| `sim` | Golden-replay: recorded input streams, assert full `SimState` field-by-field against a stored fixture after N ticks |
| `sim` | **Checkpoint-replay equivalence**: restore a full-precision `SimCheckpoint` at tick T, replay recorded inputs to T+N, assert **bit-identical** `SimState` versus the straight-through run *in the same process* |
| `protocol` | **Wire round-trip bounds**: `decode(encode(x))` differs from `x` by less than each field's stated quantization step; asserted against the epsilon constants |
| `net` | `LoopbackTransport` at 150ms latency, 50ms jitter, 5% loss; assert client converges and stays within epsilon, and that steady-state quantization noise triggers **zero** corrections |
| `net` | **Promotion test**: kill the host mid-race, assert the shadow's state matches the host's last checkpoint within bounds, no lap counter regresses, no entity disappears, and no event is applied twice |
| Tracks | Validator: closed spline, complete monotonic checkpoint ring, no unreachable geometry |
| Tracks | **Bot-drivability**: a bot completes 3 laps with zero respawns |
| `render` | Scene-graph assertions against a mocked renderer; visuals are owner-verified |
| E2E | Playwright drives two browser contexts joining by code and finishing a race |

Two notes on the determinism claims, since review found the original wording
overclaimed:

**Bit-identity is only ever asserted same-process.** IEEE-754 doubles are
deterministic for `+ - * / sqrt`, but `Math.sin`/`cos`/`pow` are not
precision-specified by ECMA-262 — they are stable within one engine version, not
across engines. The design never needs cross-device determinism, because it uses
snapshot-plus-reconciliation rather than lockstep. The checkpoint-replay test
therefore runs in one process, where bit-identity is both achievable and
meaningful.

**Golden-replay compares fields, not hashes.** Hashing float state produces a
test that fails informatively never and mysteriously often.

The zero-corrections-in-steady-state assertion is the one that protects against
the epsilon being set below the quantization step — the defect that would ship
as an unexplained visual buzz.

### What CI cannot verify

Stated plainly rather than papered over:

- How the game **feels** on a real phone.
- The **NFC tap**. HCE requires two physical devices in contact.

Both are owner-verified.

---

## 9. Build and deploy

- **CI:** GitHub Actions — typecheck, unit tests, e2e, then publish a multi-arch
  public image to `ghcr.io/atvriders/tapkart` and build the APK.
- **JDK:** CI uses JDK 21 via `setup-java` for the Android build. Local
  development uses the existing JDK 17 at `~/toolchain/jdk17` for the web side
  only. The Capacitor major version is pinned in `package.json`.
- **Android CI needs** the SDK installed with licenses accepted, Gradle caching,
  and the signing keystore — none of which are default.
- **Signing:** a **stable keystore, generated once**, stored base64 in repo
  secrets with its passwords, used for every CI build. Its SHA-256 goes in
  `/.well-known/assetlinks.json`. **Back it up the day it is created** — losing
  it breaks App Links verification and update installs for every user.
- **APK distribution:** published as a GitHub Release asset, since the owner is
  responsible for on-device NFC verification.
- **Self-host:** compose file, port 3031.
- **Domain:** Cloudflare Tunnel, which must serve `/.well-known/assetlinks.json`
  with no redirect.

No real LAN IPs, hostnames, or host paths appear in the repo. Placeholders and
RFC 5737 ranges only; the owner substitutes locally.

---

## 10. Delegation to DeepSeek

**Kept in-house:** architecture, netcode, physics, protocol design, the NFC
plugin. These are judgment-dense and expensive to get wrong.

**Delegated:** schema-constrained bulk content.

- Six track datasets (40–80 control points each plus segment metadata)
- Eight character and eight kart descriptors
- Item tuning table variants
- Per-track theme palettes

Method: one instruction held byte-identical across all jobs in a family so the
prompt cache warms across runs; per-item detail goes in the body, never the
instruction. Output validated with `--expect json`, then run through the track
validator and the bot-drivability test before human review. Cost: cents.

**Stated limit:** DeepSeek can produce a *valid* spline far faster than it can be
typed by hand, but whether a track is *fun* is judgment. Its output is
first-draft geometry to be tuned, not finished tracks.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Host phone cannot sustain authority loop plus 3D render | Arcade physics, instanced meshes, spline-analytic ground. If it still fails, degrade to client-owned kart positions — the layer boundary already exists |
| Server shadow sim limits rooms per process | Known and measurable; arcade sim is cheap. Measure early, shard if needed |
| iPhone background reading of emulated tags is inconsistent | QR and room code always displayed |
| Android 17+ adds a notification tap to the guest flow | Accepted; stated in the UI copy so the tap does not look broken |
| Losing the signing keystore | Backed up on creation; documented in the repo README |
| Symmetric NAT defeats STUN with no TURN | Server relay over WebSocket |
| Epsilon set below quantization step causes visible buzz | Zero-corrections-in-steady-state test |
| Track content is valid but unfun | Bot-drivability gates correctness; fun is human-tuned after |
| Capacitor/JDK version drift | CI pins JDK 21; Capacitor major version pinned |
