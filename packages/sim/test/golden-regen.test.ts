// Regenerating the golden fixture is an explicit, opt-in, developer-machine-only act:
//
//   UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts
//
// Without UPDATE_GOLDEN=1 the regeneration case is skipped, so this file is inert in a normal
// suite run. With UPDATE_GOLDEN=1 inside CI it fails loudly instead of quietly rewriting the
// thing CI is supposed to be checking.
import { describe, expect, it } from 'vitest'

import { MAX_KARTS } from '../src/types'
import { makeContext, makeOvalTrack } from './fixtures/track-fixtures'
import type { GoldenFixture } from './fixtures/golden-format'
import {
  GOLDEN_CHARACTER_IDX,
  GOLDEN_FORMAT_VERSION,
  GOLDEN_PATH,
  GOLDEN_REGEN_COMMAND,
  GOLDEN_SEED,
  INTENT_SCALE,
  MAX_GOLDEN_TICKS,
  assertRegenerationAllowed,
  encodeB64Lines,
  loadGoldenFixture,
  packIntents,
  saveGoldenFixture,
} from './fixtures/golden-format'
import {
  checkDrivability,
  describeDrivabilityFailure,
  diffAgainstGolden,
  formatDiffs,
  recordGoldenWithBots,
  replayGoldenFixture,
  summarizeEvents,
  toExpectation,
} from './fixtures/golden-harness'

const WANTS_REGEN = process.env.UPDATE_GOLDEN === '1'

describe('golden fixture regeneration', () => {
  it('refuses to run under CI, whatever the flag is called', () => {
    expect(() => assertRegenerationAllowed({ CI: 'true' })).toThrow(
      /refusing to regenerate because CI=true/,
    )
    expect(() => assertRegenerationAllowed({ GITHUB_ACTIONS: 'true' })).toThrow(
      /refusing to regenerate because GITHUB_ACTIONS=true/,
    )
    expect(() => assertRegenerationAllowed({ CONTINUOUS_INTEGRATION: 'yes' })).toThrow(
      /refusing to regenerate because CONTINUOUS_INTEGRATION=yes/,
    )
    expect(() => assertRegenerationAllowed({ CI: 'false' })).not.toThrow()
  })

  it.runIf(WANTS_REGEN)(
    'records a fresh 3-lap 8-bot race and writes the fixture',
    () => {
      assertRegenerationAllowed(process.env)

      const ctx = makeContext(makeOvalTrack())
      const rec = recordGoldenWithBots(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX, MAX_GOLDEN_TICKS)

      const drive = checkDrivability(rec.run.end, rec.run.events)
      if (!drive.ok) throw new Error(describeDrivabilityFailure(drive))
      expect(drive.finishedPlayerIds).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      expect(drive.respawnCount).toBe(0)
      expect(rec.intents).toHaveLength(rec.run.ticks)
      expect(rec.intents[0]).toHaveLength(MAX_KARTS)

      const fx: GoldenFixture = {
        formatVersion: GOLDEN_FORMAT_VERSION,
        generatedBy: GOLDEN_REGEN_COMMAND,
        trackId: ctx.track.id,
        raceSeed: GOLDEN_SEED,
        characterIdx: GOLDEN_CHARACTER_IDX.slice(),
        tickCount: rec.run.ticks,
        intentScale: INTENT_SCALE,
        intentsB64: encodeB64Lines(packIntents(rec.intents)),
        expected: toExpectation(rec.run.end),
        events: summarizeEvents(rec.run.events),
      }
      saveGoldenFixture(fx)

      // A fixture that cannot reproduce itself is worse than no fixture, so prove it on the
      // way out - reload from disk and replay the stream we just wrote.
      const reloaded = loadGoldenFixture()
      const check = replayGoldenFixture(ctx, reloaded)
      expect(formatDiffs(diffAgainstGolden(reloaded.expected, check.end))).toBe('')

      // eslint-disable-next-line no-console
      console.log(
        `golden: wrote ${GOLDEN_PATH} - ${fx.tickCount} ticks, ` +
          `${fx.events.total} events, finish order [${fx.expected.finishedOrder.join(', ')}]`,
      )
    },
    600_000,
  )
})
