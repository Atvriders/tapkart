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

Only the host needs the APK. Everyone else joins by tap, QR, or a five-character
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
  path. That path is `LOBBY_PATH_PREFIX` (`/r/`) from `@tapkart/protocol`, and it
  is **frozen at the first signed release**: an installed APK verifies the prefix
  it was built with, so a server that later routes some other path fails
  silently — the tap opens a browser, and nothing logs an error anywhere.
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

Because of those last two, **QR and a five-character room code are always
displayed alongside** the NFC invite. Nobody is ever blocked from joining.

*Amended 2026-08-14 (Plan 2 Task 15c): four characters became five.* The code is
drawn from a 32-symbol alphabet, so four is a keyspace of 32⁴ ≈ 1.05 M — small
enough for one host to sweep inside the ten minutes a room lives, and IP-keyed
rate limiting cannot be relied on to stop it, because a Cloudflare Tunnel
presents every request as one TCP peer. 32⁵ ≈ 33.5 M is 32× the space for one
more typed character. The alphabet, the length and the `/r/` lobby path prefix
are exported from `@tapkart/protocol`, which is the one package `game`, `server`
and the invite path all depend on.

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

**It also means instanceable, and Plan 1 shipped one violation of that.**
*Amended 2026-08-14.* The 30 Hz bot-input hold lives in `packages/sim/phase.ts`
at module scope — the only mutable binding in the package that survives a call,
so it belongs to the *process*, not to a `SimState`. Two rooms ticking in one
Node process interleave their `resolveInputs` calls and drive each other's bots:
measured at 3 cm of positional divergence after 40 ticks, silently, with no error
and no failing test. That contradicts §5's "one 60Hz arcade sim per active room"
and §11's rooms-per-process budget.

**Plan 2 moves the hold into `SimState`** (a `heldBotIntent: Intent[]` of
`MAX_KARTS` plus its parity tick). This is a locked-contract amendment, and it is
done at the *start* of Plan 2 rather than later because it edits `types.ts` and
gets strictly more expensive once `net`, `server` and `game` import the package.
It also makes the checkpoint-parity precondition **evaporate**: with the hold
inside the state, `cloneState` carries it, any tick becomes a legal checkpoint,
and `replayRun`'s `RangeError` guard retires. That guard stays until the move
lands, because until then it is the only thing between a caller and silent
divergence.

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
| boost timer | 7 |
| respawn timer | 7 |
| shielded | 1 |
| **total** | **178 bits** |

*The `bot/connected flags` row above is **two** bits, one each, not one shared
bit. `isBot === !connected` happens to hold in shipped code but nothing enforces
it, and the drop/reclaim path in "Other failure handling" is exactly where they
could legitimately disagree for a tick.*

**Invariant:** the per-kart record is a complete projection of every field in
`SimState`'s kart struct. A field absent from this table cannot exist in the
kart struct.

*Amended 2026-08-14, after Plan 1's whole-branch review found the invariant
already violated.* `KartState` carries four fields the original table omitted.
Three are per-tick dynamic state that directly gates prediction and are now
listed above: `boostTicks` (7 bits — it gates a ×1.35 speed multiplier for up
to 90 ticks, so a client reconciling without it mispredicts speed for 1.5 s
after every boost), `respawnTicks` (7 bits — it drives the whole respawn
interpolation and the motion lock), and `shielded` (1 bit — it decides whether
the next hit spins you out). The fourth, `characterIdx`, is deliberately **not**
here: it is static for the race and arrives over the reliable channel at
character select, so it is not per-tick state and the invariant does not reach
it. That exception is stated so the next reader does not "fix" it.

Entity record: `{entityId u16, kind u4, ownerId u3, position 3×u16,
velocity 3×u12, heading u12, ttl u16}` = **135 bits**. Typically 0–6 live,
capped at 32.

*Amended 2026-08-14, twice.* First, `ttl` was `u8`, which maxes at 255 while
`Tuning.entityTtl` is **600** — the wire format could not represent the tuning
the simulation actually runs, and a live seeker at `ttl 560` appears in the
shipped golden fixture. Widened to `u16`.

Second, velocity and heading were a single packed `u16`. That is incompatible
with the protocol's `WireEntity.velocity: Vec3`, which needs three independent
components, and entities are *interpolated* rather than predicted — per-axis
velocity is precisely what makes that interpolation good. Split into
`velocity 3×u12` + `heading u12`. Costs ~4 B per live entity, capped at 32.

Header, **202 bits**:

| Field | Bits |
|---|---|
| tick | 32 |
| eventSeq | 32 |
| **race phase** | **2** |
| per-player `lastProcessedInputTick` | 8 × 16 |
| entity count | 8 |
| **total** | **202 bits** |

*The `race phase` row was added 2026-08-14 (Plan 2 Task 15c).* Without it a guest
could never be told the race had **not** started: `ClientLoop` forced
`phase = 'racing'` at construction because the wire carried no answer, so every
guest drove away while the host was still counting down, and every snapshot in
that window was a guaranteed correction. Two bits, `'countdown' | 'racing' |
'finished'`.

It is in the **header**, once per snapshot, and deliberately **not** a 23rd row
of the per-kart table: that table's stated invariant is that it is a complete
projection of `SimState`'s *kart* struct, and `phase` is not on the kart struct.
Encoding it per kart would also put eight copies of one global value on the wire
— a format capable of expressing eight karts disagreeing about whether the race
has started.

**Bandwidth, recomputed honestly:**

| | Typical (6 entities) | Worst case (32 entities) |
|---|---|---|
| Snapshot size | ~305 B | ~744 B |
| Down per client @20Hz | ~6.1 KB/s | ~14.9 KB/s |
| Host up (8 peers + shadow) | ~55 KB/s | ~134 KB/s |

*Recomputed 2026-08-14 from the bit counts rather than from rounded byte figures:
`8 × 178` bits of karts + `135` bits per live entity + a `202`-bit header, all in
one continuously bit-packed stream with no per-record padding. Typical is
`2436 bits ≈ 305 B`; worst case is `5946 bits ≈ 744 B`.*

*Recomputed again for the 2-bit phase field: the raw totals moved by two bits
(2434 → 2436 and 5944 → 5946) and both byte figures round up by one (304 → 305,
743 → 744). Every KB/s figure below is unchanged to the tenth: 305 B × 20Hz is
6.1 KB/s down per client, and × 9 recipients is 54.9 KB/s up at the host, against
744 B × 20 × 9 = 134 KB/s worst case.*

*The worst case is up from ~110 KB/s to ~134 KB/s on the host's uplink. That is
still inside what wifi and LTE carry comfortably, and it only occurs with all 32
entity slots live — a state the pool cap makes rare and bounded. The alternative
was a snapshot that cannot reconcile boost, respawn or shield state at all, and an
entity velocity too coarse to interpolate well. Delta encoding against the last
acked snapshot remains the available optimisation if this ever proves tight; v1
still ships uncompressed.*

Comfortable on wifi and LTE. Delta encoding against the last acked snapshot is
an available optimization if the worst case proves tight; v1 ships uncompressed.

### Prediction and reconciliation

The client runs `step()` locally at 60Hz on its own input immediately and keeps
a ring buffer of `(tick, input, SimCheckpoint)` — full precision, in memory.

When a `WireSnapshot` arrives, the client dequantizes the authoritative state
for its own kart and compares it against its own buffered state **at
`snap.tick`**. If any field differs by more than its **per-field epsilon**, the
client resets to the authoritative value and replays every buffered input
forward to the present frame. At 100ms RTT that is 6–10 ticks of a cheap arcade
simulation — well under a millisecond.

*Amended 2026-08-14. This paragraph originally said the comparison happens "at
`lastProcessedInputTick`", and that is wrong in a way that only shows up under
load.* A `WireSnapshot` carries **one** `tick` describing a single coherent
state of the world. `lastProcessedInputTick` is a *different*, per-player number
— the newest input from that player the authority had folded in — and under real
latency it lags `snap.tick`. Comparing the authoritative state at one instant
against the predicted state at another guarantees a mismatch on almost every
snapshot. A Plan 2 author built a working prototype of the literal reading and
measured **hundreds** of spurious corrections in the steady-state test that is
supposed to see zero; the task's independently-written shadow-authority brief had
already reached the same conclusion unprompted.

`lastProcessedInputTick` keeps its real job: it tells the client **which buffered
inputs the authority has already consumed**, and therefore which ones must be
replayed forward after a reset. It is an input-buffer cursor, not a comparison
instant.

Each epsilon is derived from, and must exceed, that field's quantization step —
otherwise quantization noise alone triggers a correction every single snapshot
and the kart visibly buzzes. The epsilon constants and the quantization
constants live together in `protocol` and are asserted against each other in
tests.

**Three amendments from implementation, 2026-08-14.** All three were measured,
not reasoned, and each replaces a sentence above that is wrong in a way only
running code exposes.

*First: the client predicts on the **wire form** of its own intent.* `encodeInput`
quantizes `steer` to 8 bits and `accel` to 6. A client that predicts using its raw
analog input is simulating an input the authority never receives, and the
resulting divergence is not noise — measured at **186 corrections per 600 ticks**,
against 1 for the wire form. The client sends the raw intent and predicts on
`decode(encode(raw))`, which is bit-identically what the authority decodes. It
banks the wire form in its ring, so replay reproduces the input the simulation
actually consumed.

*Second: "resets to the authoritative value" is **per field, with the epsilon as a
dead band**.* A field already agreeing within its epsilon keeps the client's
full-precision predicted value; only fields that exceed their epsilon are
overwritten. This is not a relaxation, it is the more accurate operation: a wire
value carries up to half a quantization step of error, so overwriting an agreeing
field trades a good estimate for a worse one, and the injected residual then
integrates. (The information-theoretically optimal switch point is nearer one full
step than one epsilon; epsilon is chosen because it is the constant the contract
already blesses, and it is strictly better than no dead band.)

*Third, and the one that matters most: **a literal "zero corrections end to end" is
unreachable, and the spec never actually asked for it.*** Velocity crosses the wire
in 12 bits, so a rebase lands within half a step — 0.0156 m/s — of the authority's
true value, which is about a third of `EPS.velocity` and therefore invisible to
every later comparison. The simulation has no absolute-position feedback term, so
that residual integrates into position without bound and crosses `EPS.position`
in roughly three seconds. Heading is worse: a sub-epsilon 0.0024 rad error at
20 m/s is 0.048 m/s of lateral drift, one second to cross. **Once a client has
corrected even once — and the startup transient guarantees it, before the
authority has received any input at all — it is on a permanently offset
trajectory.** Measured across 20 transport seeds: 1–2 corrections per 600-tick
window, never zero.

Section 8's assertion is unaffected, because it asks about *quantization noise*
specifically, and names its own purpose: catching an epsilon set below its
quantization step. That is tested against a mirrored authority where quantization
is the only difference between the two simulations — where the zero is exact, and
where setting `EPS.position` below its step turns it into 296. The end-to-end
figure is a separate, composite measurement with a documented bound.

**A consequence that is not a defect but must not be discovered on a phone:** under
input that *changes* — which is all real driving — corrections rise to roughly
three per second (measured: 1 held-steady, 29 under a sine, 39 under a square wave,
per 600 ticks). This is not a client-side omission; predicting against the intent
the authority is holding was implemented and measured to change nothing. It falls
out of this section's own rule that the authority applies the newest intent it has
*received* at its own tick, rather than buffering inputs by the tick they were
stamped for. Under jitter, which intent is newest at authority-tick T is a fact
about packet delivery that no client can predict.

The alternative — a tick-buffered authority with a playout delay — trades this for
added input latency on every control, on a touchscreen arcade racer where input
latency is the thing players feel first. **We keep immediate application and
absorb the corrections in rendering**: corrections are small (they fire just past
`EPS.position`, ~5 cm, against 33 cm of travel per tick at speed), so `render`
eases the visual offset to zero rather than snapping the kart. Error smoothing is
therefore a *required* part of the render layer, not a polish item — it is what
makes this trade honest.

Remote karts and all world entities are not predicted. They are buffered and
rendered approximately 100ms in the past with interpolation, extrapolating
briefly and with a hard cap when the buffer starves.


Remote karts and all world entities are not predicted. They are buffered and
rendered approximately 100ms in the past with interpolation, extrapolating
briefly and with a hard cap when the buffer starves.

### Events

Item grants, entity spawns and despawns, hits, spin-outs, and lap crossings
travel the reliable channel carrying a **global monotonic `eventSeq`** assigned
by the current authority. Clients apply each event once and ignore any
`eventSeq` at or below the highest already applied — which is what makes
migration safe.

**Only an authority emits, and Plan 1 ships this half-done.** *Amended
2026-08-14.* "Assigned by the current authority" has a consequence the sim did
not honour: `emit()` both appends the event **and** advances `SimState.nextEventSeq`,
a field `statesEqual` compares and `AuthorityCheckpoint` carries. Plan 1 gates
`emit` on `ctx.isLeader` at 3 of its 11 call sites, so a follower running
identical inputs advances the counter by a *different* amount than the leader —
provably, by the count of item grants plus phase finishes. `phase.ts` even names
the hazard in a comment before seven other sites commit it.

**The rule, applied to all eleven sites: a non-leader never emits.** Gating
*none* of them does not work, because item rolls are leader-only by design, so
the leader emits an `itemGrant` a follower can never produce locally — the
counters diverge either way. Gating all of them does work: a follower's
simulation is unchanged (spin-outs, respawns and lap crossings still *happen*;
only their announcement is suppressed), and its `nextEventSeq` is set by the
events it **applies** from the wire. That is what "assigned by the current
authority" means operationally, and it is what §5's promotion test — "no event is
applied twice" — is written against.

This could not be fixed inside Plan 1 because the apply side does not exist
there; `net` owns it. Plan 2 implements both halves together.

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

1. Host creates a room. Server mints a five-character code (`ROOM_CODE_ALPHABET`,
   `ROOM_CODE_LENGTH`, both from `@tapkart/protocol`) and a URL under
   `LOBBY_PATH_PREFIX` (`/r/`), and starts a shadow loop.
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
