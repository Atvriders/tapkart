import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Intent } from '@tapkart/sim'
import { COUNTDOWN_TICKS, RACE_LAPS, TICK_DT, wrapAngle } from '@tapkart/sim'
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

const SHELL_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/shell.ts', import.meta.url)),
  'utf8',
)

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
  it('retains a correction from the first tick of one catch-up frame', () => {
    const pair = makeCorrectingGuest(180)
    const guest = pair.guest
    const localId = guest.localPlayerId
    const builder = createViewBuilder(guest)
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

    let found = false
    for (let tick = 181; tick <= 600; tick++) {
      guestIntent.steer = Math.sin(tick / 12)
      pair.host.tickOnce(hostIntent)
      const before = guest.corrections()
      guest.tickOnce(guestIntent)

      if (guest.corrections() === before) {
        builder.build(0, guest.currentView())
        guest.swapViews()
        pair.pump(renderNowMs(tick, 0))
        continue
      }

      const deltaPos = { x: 0, y: 0, z: 0 }
      const deltaHeading = guest.correctionDelta(deltaPos)
      expect(deltaHeading).not.toBeNull()
      expect(
        Math.hypot(deltaPos.x, deltaPos.y, deltaPos.z) + Math.abs(deltaHeading ?? 0),
      ).toBeGreaterThan(1e-6)

      // This is the first of two sim ticks emitted by one render frame. It must
      // advance the ViewBuilder at the current-tick endpoint, but must not swap
      // the rendered views or consume audio.
      const intermediate = guest.currentView()
      builder.build(1, intermediate)
      const correctedKart = guest.state().karts[localId]
      const intermediateOffset =
        Math.hypot(
          intermediate.karts[localId].position.x - correctedKart.position.x,
          intermediate.karts[localId].position.y - correctedKart.position.y,
          intermediate.karts[localId].position.z - correctedKart.position.z,
        )
        + Math.abs(wrapAngle(intermediate.karts[localId].heading - correctedKart.heading))
      expect(intermediateOffset).toBeGreaterThan(1e-6)

      // No pump means no new snapshot can reconcile on the later catch-up tick.
      // ClientLoop clears correctionDelta here, which was the production bug:
      // waiting until after this tick to build loses the first tick's delta.
      pair.host.tickOnce(hostIntent)
      guestIntent.steer = Math.sin((tick + 1) / 12)
      guest.tickOnce(guestIntent)
      expect(guest.corrections()).toBe(before + 1)
      expect(guest.correctionDelta(deltaPos)).toBeNull()

      const alpha = 0.5
      const previous = guest.prevState().karts[localId]
      const current = guest.state().karts[localId]
      const rawX = previous.position.x + (current.position.x - previous.position.x) * alpha
      const rawY = previous.position.y + (current.position.y - previous.position.y) * alpha
      const rawZ = previous.position.z + (current.position.z - previous.position.z) * alpha
      const rawHeading = wrapAngle(
        previous.heading + wrapAngle(current.heading - previous.heading) * alpha,
      )

      const view = guest.currentView()
      builder.build(alpha, view)
      const retained =
        Math.hypot(
          view.karts[localId].position.x - rawX,
          view.karts[localId].position.y - rawY,
          view.karts[localId].position.z - rawZ,
        ) + Math.abs(wrapAngle(view.karts[localId].heading - rawHeading))
      expect(retained).toBeGreaterThan(1e-6)
      found = true
      break
    }

    expect(found).toBe(true)

    // shell.ts is a DOM adapter and stays unimported in node CI. Read its loop
    // to bind the real correction proof above to the production catch-up path.
    const loopStart = SHELL_SOURCE.indexOf('for (let i = 0; i < ticks; i++)')
    const loopEnd = SHELL_SOURCE.indexOf('const alpha = accumulatorAlpha(acc)', loopStart)
    expect(loopStart).toBeGreaterThan(-1)
    expect(loopEnd).toBeGreaterThan(loopStart)
    const catchUpLoop = SHELL_SOURCE.slice(loopStart, loopEnd)
    expect(catchUpLoop).toContain('if (i < ticks - 1)')
    expect(catchUpLoop).toContain('r.builder.build(1, r.session.currentView())')
    expect(catchUpLoop).not.toMatch(/audio\.apply|swapViews/)

    pair.host.close()
    guest.close()
  })

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
