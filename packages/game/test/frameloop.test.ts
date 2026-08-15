import { describe, expect, it } from 'vitest'
import type { Intent } from '@tapkart/sim'
import { COUNTDOWN_TICKS, RACE_LAPS, TICK_DT } from '@tapkart/sim'
import {
  ERROR_SMOOTH_WINDOW_TICKS,
  buildAudioModel,
  buildHudModel,
  createAudioModel,
  createHudModel,
} from '@tapkart/render'
import { renderNowMs } from '../src/clock'
import { createSoloTransport } from '../src/localinput'
import { createSession } from '../src/session'
import { createViewBuilder } from '../src/view'
import { makeCorrectingGuest, makeGameContext } from './fixtures/game-fixtures'

const ONE_SHOTS = new Set([
  'lapCross',
  'finish',
  'spinOut',
  'respawn',
  'itemPickup',
  'itemUse',
  'boost',
  'impact',
])

describe("the frame loop's two views (§5.10, §5.13)", () => {
  it('fires exactly one lapCross cue across a race that crosses one lap', () => {
    const intent: Intent = {
      tick: 0,
      steer: 0,
      accel: 0,
      brake: false,
      drift: false,
      useItem: false,
    }
    const session = createSession({
      role: 'solo',
      ctx: makeGameContext(true),
      localPlayerId: 0,
      seed: 0x5eed,
      characterIdx: [0, 1, 2, 3, 4, 5, 6, 7],
      transport: createSoloTransport(),
    })
    const builder = createViewBuilder(session)
    const audio = createAudioModel()
    const hud = createHudModel()

    const ticks = COUNTDOWN_TICKS + 60
    const crossAt = COUNTDOWN_TICKS + 30
    let lapCross = 0
    let firstFrameOneShots = 0

    for (let tick = 1; tick <= ticks; tick++) {
      session.tickOnce(intent)
      if (tick === crossAt) session.state().karts[0].lap.lap += 1

      const view = session.currentView()
      builder.build(0, view)
      buildHudModel(view, RACE_LAPS, hud)
      buildAudioModel(session.prevView(), view, audio)
      for (let cue = 0; cue < audio.cueCount; cue++) {
        const kind = audio.cues[cue].kind
        // Audio carries one-shots for the whole field. Count the deliberately
        // advanced local seat; bots may legitimately cross during this window.
        if (kind === 'lapCross' && audio.cues[cue].playerId === 0) lapCross++
        if (tick === 1 && ONE_SHOTS.has(kind)) firstFrameOneShots++
      }
      expect(session.currentView()).not.toBe(session.prevView())
      session.swapViews()
    }

    expect(firstFrameOneShots).toBe(0)
    expect(lapCross).toBe(1)
    expect(hud.lap).toBeGreaterThanOrEqual(1)
    session.close()
  })
})

describe('error smoothing, end to end (§8.1, R41)', () => {
  it('eases a real correction to zero instead of snapping', () => {
    const pair = makeCorrectingGuest(180)
    const guest = pair.guest
    const localId = guest.localPlayerId
    const builder = createViewBuilder(guest)
    const maxTravelPerTick = guest.ctx.tuning.maxSpeed * TICK_DT

    const hostIntent: Intent = {
      tick: 0,
      steer: 0.1,
      accel: 1,
      brake: false,
      drift: false,
      useItem: false,
    }
    const guestIntent: Intent = {
      tick: 0,
      steer: 0,
      accel: 1,
      brake: false,
      drift: false,
      useItem: false,
    }

    const offsets: number[] = []
    const jumps: number[] = []
    const correctedOnFrame: boolean[] = []
    const respawnTicks: number[] = []
    let corrections = pair.corrections()
    let seenCorrections = 0
    let previousDrawn: { x: number; y: number; z: number } | null = null

    const sineTicks = 240
    const sineEnd = 180 + sineTicks
    const tailTicks = ERROR_SMOOTH_WINDOW_TICKS * 4
    for (let tick = 181; tick <= sineEnd + tailTicks; tick++) {
      guestIntent.steer = tick <= sineEnd ? Math.sin(tick / 12) : 0.1
      pair.host.tickOnce(hostIntent)
      guest.tickOnce(guestIntent)
      // Stop introducing snapshots during the quiet tail. The first tail tick
      // still consumes anything delivered by the final sine-frame pump; after
      // that the smoother gets a real correction-free decay window.
      if (tick <= sineEnd) pair.pump(renderNowMs(tick, 0))

      const view = guest.currentView()
      builder.build(0, view)

      const drawn = view.karts[localId].position
      const source = guest.prevState().karts[localId].position
      offsets.push(Math.hypot(drawn.x - source.x, drawn.y - source.y, drawn.z - source.z))
      respawnTicks.push(view.karts[localId].respawnTicks)

      const currentCorrections = pair.corrections()
      const corrected = currentCorrections > corrections
      correctedOnFrame.push(corrected)
      if (corrected) seenCorrections++
      corrections = currentCorrections

      if (previousDrawn !== null) {
        jumps.push(
          Math.hypot(
            drawn.x - previousDrawn.x,
            drawn.y - previousDrawn.y,
            drawn.z - previousDrawn.z,
          ),
        )
      }
      previousDrawn = { x: drawn.x, y: drawn.y, z: drawn.z }
      guest.swapViews()
    }

    expect(pair.corrections()).toBeGreaterThan(0)
    expect(seenCorrections).toBeGreaterThan(0)

    const absorbed = offsets.filter((distance) => distance > 1e-9).length
    expect(absorbed).toBeGreaterThan(0)
    expect(Math.max(...offsets)).toBeGreaterThan(1e-6)

    for (let frame = 1; frame < offsets.length; frame++) {
      // At alpha 0 the correction tick deliberately applies zero of the new
      // inverse; the next tick is where the retained offset first appears.
      if (correctedOnFrame[frame] || correctedOnFrame[frame - 1]) continue
      expect(`frame ${frame}: ${offsets[frame] <= offsets[frame - 1] + 1e-9}`).toBe(
        `frame ${frame}: true`,
      )
    }

    expect(offsets[offsets.length - 1]).toBeLessThan(1e-6)
    // Respawn deliberately relocates a kart and is not ordinary motion. The
    // original two-tick travel bound remains unchanged for every racing frame.
    const racingJumps = jumps.filter(
      (_jump, frame) => respawnTicks[frame] === 0 && respawnTicks[frame + 1] === 0,
    )
    expect(racingJumps.length).toBeGreaterThan(0)
    expect(Math.max(...racingJumps)).toBeLessThan(maxTravelPerTick * 2)

    pair.host.close()
    guest.close()
  })
})
