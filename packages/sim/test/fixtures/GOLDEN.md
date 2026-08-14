# The golden-replay fixture

`golden-oval-3lap-8bot.json` is a recorded input stream for a full 3-lap, 8-kart race on
`makeOvalTrack`, plus the exact `SimState` and event stream that replaying it must produce.

## What it asserts

1. **Field-by-field state equality.** Every field of `SimState` after the final tick, compared by
   name: exactly for integers, enums and booleans, and within a stated per-field tolerance for the
   continuous ones.
2. **The event stream.** Total count, count per `AuthEventKind`, and the `(playerId, tick)` of every
   per-kart `finish` event. `updatePhase` also emits one race-level `finish` with `playerId -1` when
   the race ends: it is counted in `countsByKind.finish` (so a full race shows 9, not 8) but is not
   part of `finishes`, which is the finishing order.
3. **The spec's bot-drivability criterion.** Every kart finishes `RACE_LAPS` (3) laps *and* zero
   `respawn` events occurred across the entire run. `respawn` is one of the eight `AuthEventKind`s
   for exactly this reason: a track the bots cannot drive announces itself as respawn traffic.

## What it does not assert

The fixture compares **the final tick's state** plus **an event summary**. Nothing in between is
stored, so there is a shape of bug it cannot see:

> A transient that fully self-corrects before the final tick, and that changes no finish tick and no
> per-kind event count, leaves this fixture green.

Concretely: a field that goes wrong on tick 900 and is back to the right value by tick 5802, having
emitted the same events along the way, is invisible here. So is a mid-race divergence that happens
to reconverge — the karts are on rails between checkpoints, so "wrong then right again" is not as
exotic as it sounds.

This is a **stated trade-off, not a defect**. The alternative that would catch it is a per-tick
digest, and spec §8 rejects hashing outright for the reasons in the next section: a digest names no
field, no value and no delta, so every mismatch costs a bisect and the pressure is always to
regenerate rather than to read. A fixture that is regenerated reflexively asserts nothing at all,
which is strictly worse than one with a known and written-down blind spot.

What does cover the gap, and is where a mid-race regression is expected to be caught instead:

- the per-stage unit tests, which assert behaviour at the tick it happens rather than 5000 ticks later;
- `replay.test.ts`'s checkpoint-replay equivalence, which is bit-exact from an arbitrary mid-race tick;
- the drivability criterion below, which fails on any respawn anywhere in the run, not just at the end.

## Why not a hash

A digest compresses ~1000 numbers into one. When it mismatches, the failure reads
`expected "a3f1c2…" to be "9c0417…"` — it **names no field, no value and no delta**. It cannot tell
"the drift charge tier boundary moved one tick" from "kart 6 fell through the floor on lap 2", nor
1e-15 metres of harmless float noise from 40 metres of broken physics. Every mismatch costs a bisect.

A digest also forces exact comparison onto continuous fields, so a legal re-association of a
floating-point sum turns the suite red for no behavioural reason. Teams respond by regenerating
reflexively, and a reflexively-regenerated fixture asserts nothing.

This fixture therefore compares fields and prints, for each difference: the path, the expected
value, the actual value, the delta, and the tolerance that was applied.

## Tolerances

| Field | Tolerance | Compared as |
|---|---|---|
| `position.{x,y,z}` | 1e-6 m | band |
| `velocity.{x,y,z}` | 1e-6 m/s | band |
| `heading` | 1e-7 rad | shortest signed angle, wrapped to (-PI, PI] |
| `angularVelocity` | 1e-7 rad/s | band |
| `drift.charge` | 1e-6 | band |
| `lap.t` | 1e-9 | band |
| everything else | — | exact (`Object.is`, with `-0` normalised to `+0`) |

Sizing: at a position magnitude of ~1e3 m one ULP is ~1.1e-13 m, so a few thousand ticks of
fully-correlated round-off is bounded near 4e-10 m. The smallest physically meaningful change is one
tick of acceleration — `accelRate` 24 m/s² × `TICK_DT` 1/60 s = 0.4 m/s, i.e. 6.7e-3 m of position.
The tolerance sits about six orders of magnitude above the noise and six below the signal.

Headings are compared as angles so that a kart sitting on ±π does not report a 2π "difference" that
is really the same direction. The wrap invariant is checked separately: any heading outside
(-PI, PI] is reported as `…heading[wrapped]`.

## Format

```
formatVersion  1
generatedBy    the command that regenerates this file
trackId        makeOvalTrack().id
raceSeed       20260813
characterIdx   [0,1,2,3,4,5,6,7]  - one of each character
tickCount      number of recorded ticks
intentScale    10000  - steer and accel are stored on a 1/10000 grid
intentsB64     the packed input stream, base64, split into 120-character lines
expected       the full SimState after the last tick
events         total, per-kind counts, and every finish
```

The packed stream is 5 bytes per kart per tick: `int16` steer (units 1/10000, little-endian),
`int16` accel, `uint8` flags (`1` brake, `2` drift, `4` useItem). Rows are 8 karts. The generator
**quantises before simulating**, so the stream that is stored is byte-identical to the stream that
produced the expectation, and replay is exact rather than merely close.

The fixture contains no timestamp, no hostname and no absolute path, so regenerating it with no
behaviour change produces no diff.

## Replay is not the bots

All eight karts are marked `connected: true, isBot: false` in the golden start state, so at replay
time the recorded stream is the only input source and no bot fill can run. The stream was *authored*
by `botIntent` when the fixture was recorded — which is what makes the drivability assertion
meaningful — but a later change to bot behaviour cannot move this fixture. Only physics can.

## Regenerating (intentional physics changes only)

```bash
UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts
```

- Without `UPDATE_GOLDEN=1` the regeneration case is skipped and the file is inert.
- With `CI`, `GITHUB_ACTIONS` or `CONTINUOUS_INTEGRATION` set to anything other than empty, `0` or
  `false`, it **refuses and throws**. Regenerating a golden is a claim that a physics change was
  intentional; only a human reading the diff can make that claim, so CI is never allowed to make it.
- The generator re-runs the drivability check before writing, and reloads and replays what it wrote
  before returning. A fixture that cannot reproduce itself is never committed.

Regenerate only when you meant to change physics. Read the resulting diff field by field: it is the
record of what your change did to the race.
