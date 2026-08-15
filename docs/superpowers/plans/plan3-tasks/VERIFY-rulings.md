# Plan 3 — controller rulings on the anchor-verification findings

Binding. Applied to the task files before assembly.

## Broken anchors

**B1 — §8.1's "error smoothing, end to end" assertion has no owning task; `makeCorrectingGuest` has no consumer. → Task 21.**

These are the same hole seen from both ends: a mandatory contract assertion nobody implements, and a
fixture built to feed it that nobody calls. Task 21 already creates `packages/game/test/frameloop.test.ts`
and already drives a real session there for the audio double-buffer test, so it is the only place the
end-to-end assertion can live. It consumes `makeCorrectingGuest` (Task 20's fixture) and asserts that a
guest taking a real correction eases the visual offset to zero rather than snapping.

This one matters beyond the bookkeeping: error smoothing is required (R41) precisely *because* the
netcode corrects ~3×/second under changing input. An unowned assertion is how a required feature ships
untested.

**B2 — nothing renders a ground plane. → Task 15's adapter builds one.**

`TrackTheme.ground` is produced by Task 4 and *gated* by Task 6 (legibility thresholds in both
`roster.test.ts` and the esbuild gate), `TrackScene.bounds` is produced by Task 8 for exactly this
purpose per ruling Q19 — and no task consumes either. The shipped scene would be a ribbon floating over
the sky-bottom clear colour, with six themes gated for a colour nothing renders.

Contract §12 wins: *"a ribbon over a themed ground plane plus procedural edge markers is the whole
visual budget."* Task 15's `setScene` adds a ground quad sized from `scene.bounds` and coloured
`theme.ground`. This is an adapter change touching no pure module and no census entry.

Note the failure mode: **CI cannot see this** — §8.3 puts pixels under owner verification — so Task 23's
operator checklist must name the ground plane explicitly, or the only detector is someone noticing the
game looks wrong.

**B3, B4 — amendments 1 and 2 reached Task 8 only. Task 8 is right; Tasks 15 and 22 are stale and both break `tsc`.**

`TrackScene` carries `itemBoxes: Vec3[]`, and `buildTrackScene` takes `(ctx: SimContext, theme, opts)`.
Task 22's call site becomes `buildTrackScene(ctx, loaded.theme, DEFAULT_MESH_OPTIONS)` — the `ctx` is
already in scope eight lines above. Task 15 must also stop asserting, in prose and in its commit body,
that item boxes cannot be drawn: that was true when it was written and the amendment closed it, and
**the adapter must now actually draw them** using the index pairing with `RenderFrame.itemBoxAlpha`.

**B5 — Tasks 1 and 23 both edit `package.json` and `vitest.config.ts`. Task 1 wins.**

Task 1's `scaffold.test.ts` is the standing regression guard for both, and `apps/web` cannot resolve
`@tapkart/game` without them anyway, so they must land first regardless. Task 23's Step 1 becomes a
*verify*, matching how it already treats `vite-env.d.ts`. (Task 16 declines them and points at Task 23 —
a third opinion, also corrected.)

Harmless in effect — the edits are byte-identical and idempotent — but `git add` staging nothing reads
as a mistake to whoever runs it, and a task step that cannot fail is this project's signature defect in
its mildest form.

**B6 — `CHARACTERS` is `readonly CharacterStats[]`. Tasks 18 and 19 are corrected.**

Task 2 is the producer and declares it `readonly`. Every composition root writes `CHARACTERS.slice()`
to build a `SimContext` — the asymmetry that makes this easy to miss is that `TUNING: Readonly<Tuning>`
*does* assign to `tuning: Tuning`, while the array does not.

## Silent disagreements

**SD1 + SD2 — vertex colours are the single source of track colour. Task 8 bakes; the adapter uses a vertex-colour material with a white base.**

These are one question asked twice. Task 8 bakes the road palette into vertex colours while Task 15 also
sets it on the material (SD1), and neither colours boost pads or ramps (SD2). Applying a palette in two
places is the duplication §7.2's sole-writer rule exists to prevent, and the version that leaves boost
pads and ramps uncoloured is the one that has to change anyway.

So: **Task 8 colours every mesh it builds** — road, boost pads, ramps — into vertex colours, and Task 15's
materials carry `vertexColors: true` with a white base and set no palette of their own. One code path
colours everything, and adding a mesh type later cannot forget to colour it.

## Amendment 4 entanglement

`advanceAccumulator` cannot move to `@tapkart/net` alone: it would leave `net` importing
`TickAccumulator` from `game`, inverting the dependency direction spec §3 fixes. **The type moves with
the function.** Task 16 imports both from `@tapkart/net`; `packages/server` will do the same, which is
the whole reason for the move (ruling F-P4-7).

## From the ownership verification

**O1 — `content/` was untracked. FIXED, commit `d59043c`.**

`git ls-files content` returned nothing: the six shipped tracks existed only in the main working
tree, so Tasks 5, 6, 7, 8 and 23 all read files a worktree does not have. The plan could not run.

Committed: `content/tracks/` (6), `content/tracks-pool/` (12 reserve), `content/pipeline/` (the
instruction, the JSONL inputs and the three esbuild-built gates). Excluded and now gitignored: the
Plan 1 task reports and ledger, which are working notes and quote absolute host paths.

**O2 — my AUTHOR-DECISIONS item 3 was half wrong. The results split goes AFTER Task 19, not before.**

I ruled that splitting `results.ts` out of Task 22 into a task placed *before* 19 would clear the
`TS2307`. It would not: `app.ts` and `results.ts` import each other type-only, so moving results
earlier just **inverts** the error. Take the verifier's placement — after 19 — and its full split,
including the fact that Task 22's stated RED must be rewritten because both of its premises become
false once the steps move.

**O3 — Task 1's Plan 2 gate checks 22 of the 33 elements the plan needs.**

Missing: `AuthorityLoop`, `remoteInterpolatorOf`, `makeLoopbackPair`, `LoopbackOptions`,
`ChannelName`, `sampleKart`, `RemoteInterpolator.push`, and the `ClientLoop` methods — **every one
of them required by Task 20**. A gate that passes while a third of its surface is unchecked is worse
than no gate: Task 1 would report the gate open and Task 20 would fail with an error nobody
attributes to the gate. Widen it to all 33.

**O4 — two undeclared root writers.** `package-lock.json` (five tasks run `npm install`) and
`.gitignore` (Task 6). Declare both so a reviewer seeing them in a diff knows they were intended.

**O5 — Task 23's `package.json:6-8` line citation goes stale** once Task 1 makes its edit. Line-range
citations into files an earlier task modifies are guesses; drop the range and cite the key.
