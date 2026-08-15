# Track content pipeline

Generates Tapkart track JSON with DeepSeek and gates it with the **real** simulation
code — never a reimplementation of the rules.

## Why the gates are bundled from source, not rewritten

`track-validator.mjs` and `sim-bundle.mjs` are `packages/sim/src/*` bundled by esbuild:

    npx esbuild packages/sim/src/track.ts --bundle --format=esm --platform=node \
      --outfile=track-validator.mjs
    # sim-entry.ts re-exports buildTrackQuery/validateTrack/createState/step
    npx esbuild sim-entry.ts --bundle --format=esm --platform=node \
      --outfile=sim-bundle.mjs

So a generated track is judged by the same code the game runs. A second implementation
of these rules could drift and pass tracks the game rejects.

## Running it

    deepseek-batch --jsonl tracks.jsonl --body-field brief --id-field id \
                   --instruction @track-gen-instruction.md --expect json \
                   --model deepseek-v4-pro --dry-run      # always dry-run first
    deepseek-batch ...                                    # drop --dry-run
    node gate-tracks.mjs           # stage 1: static validateTrack
    node gate-tracks-query.mjs     # stage 2: geometry via buildTrackQuery
    node gate-tracks-bots.mjs      # stage 3: bot drivability through real step()

Keep `track-gen-instruction.md` **byte-identical** across runs. DeepSeek's prompt cache
warms across runs, not within one, and a hit is 50-120x cheaper than a miss. Per-track
detail goes in the JSONL body, never the instruction. Measured here: 15% hit rate on the
first run, **95.5%** on the next with only the body changed. A low first-run rate is
expected and is not a reason to change anything.

## The three gates, and what each one caught

Each gate found something the previous one could not. That is the argument for the ladder.

1. **`validateTrack`** — static ranges, ordering, start-grid clearance, bounds. Cheap, and
   it gates the schema. It caught nothing in the final run because the instruction already
   encodes its rules.
2. **`buildTrackQuery` probes** — arc/polygon ratio, centreline projection error, checkpoint
   reachability, and **surface overlap**.

   The overlap check is the one that matters and the easy one to get wrong. An earlier
   version "checked" self-intersection by projecting the centreline onto itself and looking
   for an `s` jump. That cannot work: a point sampled exactly on the centreline is at
   distance 0 from its own branch, so the nearest-point search always returns that branch
   no matter what crosses nearby. The real test compares pairs far apart *along* the track
   and close *in space* — closer than their two half-widths means the drivable surfaces
   physically overlap. **It caught a 1.3 m hairpin overlap in glacier-pass** that stage 1
   and the bogus round-trip test both passed.
3. **Bot drivability** — the design spec's actual gate: "a bot completes 3 laps with zero
   respawns." Drives 8 real bots through the real `step()`.

   **It caught neon-district being completely undrivable** — all 8 bots stuck on lap 1
   after 40,000 ticks with ~190 respawns each — on a track that passed stages 1 and 2.
   Its arc/polygon ratio of 1.016 (highest of the six) was the tell in hindsight: it was
   by far the curviest. Regenerated with a 40 m minimum corner radius, no hairpins, and
   18-22 m width; the ratio fell to 1.001 and it now finishes in 94.3 s with 0 respawns.

## What none of the gates tell you

Whether a track is *fun*. That is human tuning, and the design spec is explicit that this
output is first-draft geometry. All six currently pass all three gates: 82-117 s for three
laps, zero respawns.
