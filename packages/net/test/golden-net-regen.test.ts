// Regenerating the networked golden fixture is an explicit, opt-in, developer-machine-only act:
//
//   UPDATE_GOLDEN=1 npx vitest run packages/net/test/golden-net-regen.test.ts
//
// Without UPDATE_GOLDEN=1 the regeneration case is skipped, so this file is inert in a normal suite
// run. With UPDATE_GOLDEN=1 inside CI it fails loudly instead of quietly rewriting the thing CI is
// supposed to be checking.
//
// It is a separate file from golden-run.test.ts for one reason: that file loads the fixture in a
// `beforeAll`, so a missing or unloadable fixture would take the regenerator down with it - and the
// regenerator is the one thing that can fix a missing fixture.
import { describe, expect, it } from 'vitest'

import { MAX_KARTS } from '@tapkart/sim'

import type { GoldenNetFixture } from './fixtures/golden-net'
import {
  GOLDEN_NET_CHARACTER_IDX,
  GOLDEN_NET_FORMAT_VERSION,
  GOLDEN_NET_PATH,
  GOLDEN_NET_PLAYER_ID,
  GOLDEN_NET_REGEN_COMMAND,
  GOLDEN_NET_SEED,
  GOLDEN_NET_TICKS,
  encodeGoldenNetIntents,
  goldenNetTransportBlock,
  loadGoldenNetFixture,
  replayGoldenNet,
  runGoldenNet,
  saveGoldenNetFixture,
} from './fixtures/golden-net'
import { makeNetContext } from './fixtures/net-fixtures'
import { INTENT_SCALE, assertRegenerationAllowed } from '../../sim/test/fixtures/golden-format'
import { diffAgainstGolden, formatDiffs, toExpectation } from '../../sim/test/fixtures/golden-harness'

const WANTS_REGEN = process.env.UPDATE_GOLDEN === '1'

describe('golden net fixture regeneration', () => {
  it('refuses to run under CI, whatever the flag is called', () => {
    expect(() => assertRegenerationAllowed({ CI: 'true' })).toThrow(
      /refusing to regenerate because CI=true/,
    )
    expect(() => assertRegenerationAllowed({ GITHUB_ACTIONS: 'true' })).toThrow(
      /refusing to regenerate because GITHUB_ACTIONS=true/,
    )
    expect(() => assertRegenerationAllowed({ CI: 'false' })).not.toThrow()
  })

  it.runIf(WANTS_REGEN)(
    'records a fresh three-party run and writes the fixture',
    () => {
      assertRegenerationAllowed(process.env)

      const ctx = makeNetContext(true)
      // recorded === null: seat 0 is driven by botIntent against the authoritative state and the
      // resulting stream is captured. Everything else - transport, loops, ordering - is the same
      // code path a replay takes.
      const rec = runGoldenNet(null, GOLDEN_NET_TICKS)

      expect(rec.intents).toHaveLength(GOLDEN_NET_TICKS)
      expect(rec.host.tick).toBe(GOLDEN_NET_TICKS)
      // A fixture recorded from a race that did not happen is worse than none: refuse to write one
      // where nobody moved, nothing was announced and no snapshot arrived.
      for (let i = 0; i < MAX_KARTS; i++) {
        expect(rec.host.karts[i].lap.lap, `kart ${i} completed no lap`).toBeGreaterThanOrEqual(1)
      }
      expect(rec.counters.hostEventSeq).toBeGreaterThan(5)
      expect(rec.counters.snapshotsToClient).toBeGreaterThan(300)
      expect(rec.counters.snapshotsToShadow).toBeGreaterThan(300)

      const fx: GoldenNetFixture = {
        formatVersion: GOLDEN_NET_FORMAT_VERSION,
        generatedBy: GOLDEN_NET_REGEN_COMMAND,
        trackId: ctx.track.id,
        raceSeed: GOLDEN_NET_SEED,
        characterIdx: GOLDEN_NET_CHARACTER_IDX.slice(),
        drivenPlayerId: GOLDEN_NET_PLAYER_ID,
        tickCount: GOLDEN_NET_TICKS,
        intentScale: INTENT_SCALE,
        transport: goldenNetTransportBlock(),
        intentsB64: encodeGoldenNetIntents(rec.intents),
        counters: rec.counters,
        host: toExpectation(rec.host),
        client: toExpectation(rec.client),
        shadow: toExpectation(rec.shadow),
      }
      saveGoldenNetFixture(fx)

      // A fixture that cannot reproduce itself is worse than no fixture, so prove it on the way out:
      // reload from disk and replay the stream just written, through the full stack.
      const reloaded = loadGoldenNetFixture()
      const check = replayGoldenNet(reloaded)
      expect(formatDiffs(diffAgainstGolden(reloaded.host, check.host))).toBe('')
      expect(formatDiffs(diffAgainstGolden(reloaded.client, check.client))).toBe('')
      expect(formatDiffs(diffAgainstGolden(reloaded.shadow, check.shadow))).toBe('')
      expect(check.counters).toEqual(reloaded.counters)

      // eslint-disable-next-line no-console
      console.log(
        `golden-net: wrote ${GOLDEN_NET_PATH} - ${fx.tickCount} ticks, ` +
          `${fx.counters.corrections} corrections, ${fx.counters.snapshotsToClient} snapshots to the guest, ` +
          `laps [${fx.host.karts.map((k) => k.lap.lap).join(', ')}]`,
      )
    },
    600_000,
  )
})
