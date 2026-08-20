import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent } from '@tapkart/sim'
import {
  COUNTDOWN_TICKS,
  MAX_KARTS,
  RACE_LAPS,
  TICK_DT,
  startSpinOut,
  wrapAngle,
} from '@tapkart/sim'
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

/**
 * KART-TO-KART CONTACT, P3-R61.
 *
 * `sim` resolves a kart collision positionally and emits no AuthEvent for it, so
 * a bump reaches `buildAudioModel` only as a shape in the two-view delta. These
 * tests drive the real per-frame path — tickOnce, ViewBuilder.build,
 * buildAudioModel(prevView, currentView), swapViews, in shell.ts's order — over a
 * real solo session running the real `step()`. Nothing here hand-builds a
 * RaceView: a hand-built pair of views is how a one-view session shipped green
 * once, and it is also how a scenario the physics cannot produce gets asserted
 * about.
 *
 * The listener is seat 3, never seat 0, and seat 0 holds a DECOY parked on the
 * far side of the oval. `CUE_FALLOFF_M` is 60 m, so an implementation that read
 * `karts[0]` as the listener instead of `karts[localPlayerId]` scores every cue
 * below at gain 0.
 */
const LISTENER_SEAT = 3
const PARTNER_SEAT = 6
/** `2 * kartRadius` with the shipped tuning: what a resolved pair separates to. */
const CONTACT_DIAMETER_M = 1.8
/** audio.ts's private CONTACT_RANGE_M, restated rather than imported: a test that
 *  read the constant would agree with whatever value it was given. */
const CONTACT_RANGE_M = 2.5
/** `brakeRate * TICK_DT` — the most the throttle/brake axis can change one kart's
 *  velocity in one tick, and the ceiling audio.ts's push floor sits above. */
const BRAKE_DV_PER_TICK = 48 / 60

interface FrameRecord {
  /** Centre-to-centre distance between the two seats, in the newer view. */
  separation: number
  /** Signed velocity change AWAY from the partner, along the line between them. */
  pushListener: number
  pushPartner: number
  /** The whole velocity change, unprojected: what a magnitude-only rule sees. */
  deltaVListener: number
  deltaVPartner: number
  listenerSurface: string
  partnerSurface: string
  listenerAirborne: boolean
  partnerAirborne: boolean
  listenerRespawnTicks: number
  partnerRespawnTicks: number
  impacts: { playerId: number; intensity: number; pan: number }[]
  kinds: string[]
  /** Impact cues this same frame raises when it is scored against ITSELF — the
   *  one-view shell. Always zero if every cue really is a delta. */
  singleViewImpacts: number
}

interface ContactRigOptions {
  /** Give both seats the SAME character. Two karts with different weights and
   *  accelerations drift apart, take a ramp a tick apart and a pad a tick apart,
   *  which would quietly downgrade a "both karts at once" false-positive case
   *  into a "one kart at a time" one that no rule would fire on. The bump tests
   *  leave it off, so the weight split in `resolveKartCollisions` is exercised. */
  twinned?: boolean
  /** Defaults put the listener on the LOW side of the pair. Swapping them puts
   *  it on the high side, which is the other branch of the naming rule. */
  listener?: number
  partner?: number
}

interface ContactRig {
  listenerSeat: number
  partnerSeat: number
  frames: FrameRecord[]
  /** Seat, arc position, lateral offset (positive is to the RIGHT of the racing
   *  direction), forward speed, facing (+1 with the track, -1 against it), and a
   *  sideways velocity in the same right-handed sense as `lateral`. */
  place(
    seat: number,
    s: number,
    lateral: number,
    speed: number,
    facing?: number,
    lateralSpeed?: number,
  ): void
  /** Spins a seat out through `sim`'s own sanctioned writer. */
  spinOut(seat: number, ticks: number): void
  /** Rewrites BOTH session views from the placed state, so the teleport this
   *  harness performs is not itself read as a two-view delta. */
  arm(): void
  drive(opts: { accel?: number; brake?: boolean; ticks: number }): void
  /** Arc length of the fixture track, for spacing a pair along it in metres. */
  trackLength: number
  close(): void
}

function makeContactRig(opts: ContactRigOptions = {}): ContactRig {
  const listenerSeat = opts.listener ?? LISTENER_SEAT
  const partnerSeat = opts.partner ?? PARTNER_SEAT
  const ctx = makeGameContext(true)
  const transport = createSoloTransport()
  const characterIdx = [0, 1, 2, 3, 4, 5, 6, 7]
  if (opts.twinned === true) {
    characterIdx[listenerSeat] = 0
    characterIdx[partnerSeat] = 0
  }
  const session = createSession({
    role: 'solo',
    ctx,
    localPlayerId: listenerSeat,
    seed: 0xc0117d,
    characterIdx,
    transport,
  })
  const state = session.state()
  // Both halves of the pair are driven seats, so neither is steered into a
  // collision by the bot AI that this test did not arrange. The other six are
  // connected humans that never receive an input: `resolveInputs` hands such a
  // seat a zeroed intent, so each coasts to a stop where it is parked.
  for (let seat = 0; seat < MAX_KARTS; seat++) {
    state.karts[seat].isBot = false
    state.karts[seat].connected = true
  }

  const listenerIntent: Intent = {
    tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false,
  }
  const partnerIntent: Intent = {
    tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false,
  }
  const submit = (): void => {
    partnerIntent.tick = session.state().tick + 1
    transport.submitLocalInput(partnerSeat, partnerIntent)
  }

  // Out of the countdown first: `resolveInputs` freezes every intent to zero
  // until the race starts, so a scenario placed during it would not be driven.
  for (let tick = 0; tick <= COUNTDOWN_TICKS + 20; tick++) {
    submit()
    session.tickOnce(listenerIntent)
  }
  const builder = createViewBuilder(session)
  const audio = createAudioModel()
  const selfScored = createAudioModel()
  const frames: FrameRecord[] = []

  const place: ContactRig['place'] = (seat, s, lateral, speed, facing = 1, lateralSpeed = 0) => {
    const kart = session.state().karts[seat]
    const centre = ctx.query.sampleAt(s).position
    const tangent = ctx.query.tangentAt(s)
    const length = Math.hypot(tangent.x, tangent.z)
    const tx = tangent.x / length
    const tz = tangent.z / length
    const rx = -tz
    const rz = tx
    kart.position.x = centre.x + rx * lateral
    kart.position.z = centre.z + rz * lateral
    kart.position.y = ctx.query.groundHeight(s, lateral)
    kart.heading = Math.atan2(tz * facing, tx * facing)
    kart.velocity.x = tx * speed * facing + rx * lateralSpeed
    kart.velocity.y = 0
    kart.velocity.z = tz * speed * facing + rz * lateralSpeed
    kart.angularVelocity = 0
    kart.airborne = false
    kart.spinOutTicks = 0
    kart.invulnTicks = 0
    kart.respawnTicks = 0
    kart.boostTicks = 0
    kart.shielded = false
    kart.item = 'none'
    kart.drift.active = false
    kart.drift.dir = 0
    kart.drift.charge = 0
  }

  // Park the six uninvolved karts on the far side of the oval, the seat-0 decoy
  // among them, well past CUE_FALLOFF_M from anywhere the pair is placed.
  let parked = 0
  for (let seat = 0; seat < MAX_KARTS; seat++) {
    if (seat === listenerSeat || seat === partnerSeat) continue
    place(seat, 0.72 + parked * 0.02, parked % 2 === 0 ? -4 : 4, 0)
    parked++
  }

  const arm = (): void => {
    builder.build(0, session.currentView())
    session.swapViews()
    builder.build(0, session.currentView())
    session.swapViews()
  }

  const measure = (): FrameRecord => {
    const view = session.currentView()
    const prev = session.prevView()
    const a = view.karts[listenerSeat]
    const b = view.karts[partnerSeat]
    const pa = prev.karts[listenerSeat]
    const pb = prev.karts[partnerSeat]
    const dx = b.position.x - a.position.x
    const dy = b.position.y - a.position.y
    const dz = b.position.z - a.position.z
    const separation = Math.hypot(dx, dy, dz)
    const nx = dx / separation
    const ny = dy / separation
    const nz = dz / separation
    const avx = a.velocity.x - pa.velocity.x
    const avy = a.velocity.y - pa.velocity.y
    const avz = a.velocity.z - pa.velocity.z
    const bvx = b.velocity.x - pb.velocity.x
    const bvy = b.velocity.y - pb.velocity.y
    const bvz = b.velocity.z - pb.velocity.z
    const impacts: FrameRecord['impacts'] = []
    const kinds: string[] = []
    for (let i = 0; i < audio.cueCount; i++) {
      const cue = audio.cues[i]
      kinds.push(`${cue.kind}:${cue.playerId}`)
      if (cue.kind === 'impact') {
        impacts.push({ playerId: cue.playerId, intensity: cue.intensity, pan: cue.pan })
      }
    }
    // The one-view shell, scored on this very frame's data.
    buildAudioModel(view, view, selfScored)
    let singleViewImpacts = 0
    for (let i = 0; i < selfScored.cueCount; i++) {
      if (selfScored.cues[i].kind === 'impact') singleViewImpacts++
    }
    return {
      separation,
      pushListener: -(avx * nx + avy * ny + avz * nz),
      pushPartner: bvx * nx + bvy * ny + bvz * nz,
      deltaVListener: Math.hypot(avx, avy, avz),
      deltaVPartner: Math.hypot(bvx, bvy, bvz),
      listenerSurface: a.surface,
      partnerSurface: b.surface,
      listenerAirborne: a.airborne,
      partnerAirborne: b.airborne,
      listenerRespawnTicks: a.respawnTicks,
      partnerRespawnTicks: b.respawnTicks,
      impacts,
      kinds,
      singleViewImpacts,
    }
  }

  const drive: ContactRig['drive'] = (driveOpts) => {
    for (const intent of [listenerIntent, partnerIntent]) {
      intent.accel = driveOpts.accel ?? 1
      intent.brake = driveOpts.brake ?? false
    }
    for (let tick = 0; tick < driveOpts.ticks; tick++) {
      // shell.ts's frame order, verbatim: tick, build, audio, THEN swap.
      submit()
      session.tickOnce(listenerIntent)
      const view = session.currentView()
      builder.build(0, view)
      buildAudioModel(session.prevView(), view, audio)
      frames.push(measure())
      session.swapViews()
    }
  }

  const spinEvents: AuthEvent[] = []
  const spinOut = (seat: number, ticks: number): void => {
    startSpinOut(ctx, session.state(), session.state().karts[seat], ticks, spinEvents)
  }

  return {
    listenerSeat,
    partnerSeat,
    frames,
    place,
    spinOut,
    arm,
    drive,
    trackLength: ctx.query.totalLength(),
    close: () => session.close(),
  }
}

function impactsIn(frames: FrameRecord[]): FrameRecord['impacts'] {
  const out: FrameRecord['impacts'] = []
  for (const frame of frames) out.push(...frame.impacts)
  return out
}

function kindsIn(frames: FrameRecord[]): Set<string> {
  const out = new Set<string>()
  for (const frame of frames) for (const kind of frame.kinds) out.add(kind)
  return out
}

function maxOf(values: number[]): number {
  let best = -Infinity
  for (const value of values) if (value > best) best = value
  return best
}

function minOf(values: number[]): number {
  let best = Infinity
  for (const value of values) if (value < best) best = value
  return best
}

function selfScoredIn(frames: FrameRecord[]): number {
  let total = 0
  for (const frame of frames) total += frame.singleViewImpacts
  return total
}

/** Every frame is scored twice by the rig; the one-view score must always be
 *  empty, whatever the scenario, so each test can afford to say so. */
function expectDeltaDerived(rig: ContactRig): void {
  expect(selfScoredIn(rig.frames)).toBe(0)
}

describe('kart-to-kart contact is audible (P3-R61)', () => {
  /**
   * CATCHES the reported gap itself: before this change a trade of paint raised
   * no cue at all, because `sim` announces kart collisions to nobody, and the
   * `toHaveLength(1)` below read 0.
   *
   * ALSO CATCHES a listener read from `karts[0]` instead of
   * `karts[localPlayerId]`. The seat-0 decoy is parked on the far side of the
   * oval, past the 60 m falloff, so under that bug this cue's intensity is 0 and
   * its pan is taken from a kart three hundred metres away.
   */
  it('raises one impact cue, naming the other kart and panned from the local seat', () => {
    const rig = makeContactRig()
    // Seat 6 sits ahead and to seat 3's RIGHT — `right` is (-tangent.z, 0,
    // tangent.x), the sense positive `lateral` uses here — and seat 3 arrives
    // 14 m/s faster, so it clips the right rear of the kart in front.
    rig.place(rig.listenerSeat, 0.32, -0.75, 38)
    rig.place(rig.partnerSeat, 0.32 + 1.6 / rig.trackLength, 0.75, 24)
    rig.arm()
    rig.drive({ ticks: 26 })

    const impacts = impactsIn(rig.frames)
    expect(impacts).toHaveLength(1)
    // They really touched: `resolveKartCollisions` separates a pair to exactly
    // the contact diameter, and a RaceView's positions lag its velocities by up
    // to a tick, so this reads at the diameter rather than below it.
    expect(minOf(rig.frames.map((frame) => frame.separation))).toBeLessThan(
      CONTACT_DIAMETER_M + 0.1,
    )
    // Names the kart the listener is NOT: not seat 3, and not the seat-0 decoy.
    expect(impacts[0].playerId).toBe(rig.partnerSeat)
    expect(impacts[0].pan).toBeGreaterThan(0.5)
    expect(impacts[0].intensity).toBeGreaterThan(0.05)
    expect(impacts[0].intensity).toBeLessThan(1)
    expectDeltaDerived(rig)
    rig.close()
  })

  /**
   * CATCHES a cue named by the pair's lower seat rather than by "whichever of the
   * two the listener is not". The pair loop walks seats in ascending order, so
   * the test above only ever exercises the branch where the listener IS the lower
   * seat; here the seats are swapped and the correct answer flips with them. A
   * `Math.min(i, j)` implementation passes the test above and fails this one.
   */
  it('names the other kart when the listener is the higher seat of the pair', () => {
    const rig = makeContactRig({ listener: PARTNER_SEAT, partner: LISTENER_SEAT })
    expect(rig.listenerSeat).toBeGreaterThan(rig.partnerSeat)
    rig.place(rig.listenerSeat, 0.32, -0.75, 38)
    rig.place(rig.partnerSeat, 0.32 + 1.6 / rig.trackLength, 0.75, 24)
    rig.arm()
    rig.drive({ ticks: 26 })

    const impacts = impactsIn(rig.frames)
    expect(impacts.length).toBeGreaterThan(0)
    expect(impacts[0].playerId).toBe(rig.partnerSeat)
    expect(impacts[0].intensity).toBeGreaterThan(0.05)
    expectDeltaDerived(rig)
    rig.close()
  })

  /**
   * CATCHES an intensity that ignores how hard the hit was — which is exactly
   * what the shield-pop impact does (`WEIGHT_IMPACT * g`, no speed term), so it
   * is the likeliest way for this cue to be written. Under that bug all three
   * readings are one number and every comparison below fails at once. A
   * loud/quiet step function, or a curve that flattens, fails the ratio.
   *
   * The three runs are collected out of order deliberately, so the collection's
   * first, last, sum and max are four different numbers and an assertion that
   * reached for the wrong one of them cannot pass.
   */
  it('scales intensity with closing speed', () => {
    const closings = [3, 30, 7]
    const readings: number[] = []
    for (const closing of closings) {
      const rig = makeContactRig()
      rig.place(rig.listenerSeat, 0.32, 0, 24 + closing)
      rig.place(rig.partnerSeat, 0.32 + 1.9 / rig.trackLength, 0, 24)
      rig.arm()
      rig.drive({ ticks: 26 })
      const impacts = impactsIn(rig.frames)
      expect(impacts).toHaveLength(1)
      readings.push(impacts[0].intensity)
      expectDeltaDerived(rig)
      rig.close()
    }

    const light = readings[0]
    const heavy = readings[1]
    const middling = readings[2]
    expect(light).toBeLessThan(middling)
    expect(middling).toBeLessThan(heavy)

    const sum = readings[0] + readings[1] + readings[2]
    const max = maxOf(readings)
    const first = readings[0]
    const last = readings[readings.length - 1]
    expect(new Set([first, last, sum, max]).size).toBe(4)
    expect(max).toBe(heavy)
    expect(first).toBe(light)
    expect(last).toBe(middling)

    // Not merely ordered: roughly proportional to closing speed. 7/3 is 2.33,
    // and traction on the approach moves the measured ratio a little off it. A
    // step function reads 1, a square-root curve reads 1.53; both miss.
    expect(middling / light).toBeGreaterThan(2)
    expect(middling / light).toBeLessThan(3.2)
    expect(light).toBeLessThan(0.3)
    expect(heavy).toBe(1)
  })
})

describe('kart-to-kart contact stays silent for everything a wall can do (P3-R61)', () => {
  /**
   * CATCHES a rule that fires when two nearby karts both change velocity in the
   * same frame. Twinned characters make the pad grant land on BOTH karts on the
   * SAME tick, 2.3 m apart — inside the contact range, so the range gate is not
   * what produces the silence here. What produces it is that a shared effect
   * pushes both karts the same way, and one shared direction projects onto the
   * line between them with opposite signs.
   */
  it('is silent when two karts take a boost pad side by side', () => {
    const rig = makeContactRig({ twinned: true })
    rig.place(rig.listenerSeat, 0.1 - 8 / rig.trackLength, -1.15, 25)
    rig.place(rig.partnerSeat, 0.1 - 8 / rig.trackLength, 1.15, 25)
    rig.arm()
    rig.drive({ ticks: 34 })

    // The pad really fired, for both seats: the silence is a judgement about a
    // real event, not a report that the scenario never happened.
    const kinds = kindsIn(rig.frames)
    expect(kinds.has(`boost:${rig.listenerSeat}`)).toBe(true)
    expect(kinds.has(`boost:${rig.partnerSeat}`)).toBe(true)
    expect(rig.frames.some((frame) => frame.listenerSurface === 'boost')).toBe(true)
    expect(rig.frames.some((frame) => frame.partnerSurface === 'boost')).toBe(true)
    // Both karts changed velocity on the same frame, within contact range.
    const shared = rig.frames.filter(
      (frame) =>
        Math.min(frame.deltaVListener, frame.deltaVPartner) > 0.3
        && frame.separation <= CONTACT_RANGE_M,
    )
    expect(shared.length).toBeGreaterThan(0)

    expect(impactsIn(rig.frames)).toHaveLength(0)
    expectDeltaDerived(rig)
    rig.close()
  })

  /**
   * THE STRONGEST OF THESE. A ramp launch assigns `velocity.y` outright and a
   * landing zeroes it, so this puts a 7 m/s velocity discontinuity into BOTH
   * karts on the SAME frame while they are 2.3 m apart — seven times the push
   * floor and well inside the contact range. Any rule that thresholds the size of
   * the change rather than its direction fires here, twice, on every lap that has
   * a ramp on it.
   *
   * CATCHES exactly that: a magnitude-only rule, and a rule that projects onto the
   * line between the karts without keeping the signs.
   */
  it('is silent when two karts launch off a ramp and land side by side', () => {
    const rig = makeContactRig({ twinned: true })
    rig.place(rig.listenerSeat, 0.53, -1.15, 30)
    rig.place(rig.partnerSeat, 0.53, 1.15, 30)
    rig.arm()
    rig.drive({ ticks: 140 })

    // Both flew, and both were on the ground at some point too: `applyRamps` runs
    // after the vertical integration, so a kart that lands inside the ramp's arc
    // is launched again, and this pair bounces through it more than once.
    expect(rig.frames.some((frame) => frame.listenerAirborne)).toBe(true)
    expect(rig.frames.some((frame) => !frame.listenerAirborne)).toBe(true)
    expect(rig.frames.some((frame) => frame.partnerAirborne)).toBe(true)
    expect(rig.frames.some((frame) => !frame.partnerAirborne)).toBe(true)

    // The trap, armed: frames where BOTH karts' whole velocity changed by more
    // than 6 m/s at once, with the pair inside contact range the entire time.
    // There is more than one — a launch is one and a landing is another.
    const shared = rig.frames.filter(
      (frame) => Math.min(frame.deltaVListener, frame.deltaVPartner) > 6,
    )
    expect(shared.length).toBeGreaterThan(1)
    expect(maxOf(shared.map((frame) => frame.separation))).toBeLessThan(CONTACT_RANGE_M)
    expect(minOf(rig.frames.map((frame) => frame.separation))).toBeGreaterThan(
      CONTACT_DIAMETER_M,
    )
    // ...and the same frames, projected onto the line between the karts and
    // signed, are nothing at all. That is the whole discriminator, measured.
    expect(maxOf(shared.map((frame) => Math.min(frame.pushListener, frame.pushPartner))))
      .toBeLessThan(0.1)

    expect(impactsIn(rig.frames)).toHaveLength(0)
    expectDeltaDerived(rig)
    rig.close()
  })

  /**
   * `beginRespawn` zeroes a kart's whole velocity vector in one tick, so two karts
   * that leave the track nose to nose each appear to leap away from the other at
   * their full road speed. This is the one case where the geometry test is
   * satisfied — both pushes really are positive, and measured at 30 m/s each,
   * thirty times the floor — and only `collidable()`'s own rule, that a
   * motion-locked kart is not in a collision, silences it.
   *
   * CATCHES a rule with no motion-lock gate: it fires here at full intensity, on
   * every double respawn, for a contact that cannot have happened.
   */
  it('is silent when two karts respawn nose to nose', () => {
    const rig = makeContactRig({ twinned: true })
    // Both already outside `isInBounds`, so both call `beginRespawn` on the very
    // first tick, facing each other 2.3 m apart at 30 m/s.
    rig.place(rig.listenerSeat, 0.2, 30, 30, 1)
    rig.place(rig.partnerSeat, 0.2 + 2.3 / rig.trackLength, 30, 30, -1)
    rig.arm()
    rig.drive({ ticks: 80 })

    const kinds = kindsIn(rig.frames)
    expect(kinds.has(`respawn:${rig.listenerSeat}`)).toBe(true)
    expect(kinds.has(`respawn:${rig.partnerSeat}`)).toBe(true)

    // The trap, armed: a frame on which both karts gained a large velocity AWAY
    // from the other, along the line between them, inside contact range.
    const armed = rig.frames.filter(
      (frame) =>
        Math.min(frame.pushListener, frame.pushPartner) > 10
        && frame.separation <= CONTACT_RANGE_M,
    )
    expect(armed).toHaveLength(1)
    expect(armed[0].listenerRespawnTicks).toBeGreaterThan(0)
    expect(armed[0].partnerRespawnTicks).toBeGreaterThan(0)

    expect(impactsIn(rig.frames)).toHaveLength(0)
    expectDeltaDerived(rig)
    rig.close()
  })

  /**
   * The sim has no walls. The off-track shoulder is what a kerb is here: it drags
   * a kart's target speed down by `offtrackSpeedMul`, and with the brake held it
   * is the hardest the environment can slow anybody. Nose to tail, that
   * deceleration lies exactly ALONG the line between the two karts, which is the
   * arrangement that gives an unsigned rule its best shot: measured, both karts
   * change velocity by 0.8 m/s along that line on the same frame.
   *
   * CATCHES a rule written on `Math.abs(dv . n)`. The signed values here have
   * OPPOSITE signs — the kart behind gains ground on the one in front — and it is
   * the sign, not the size, that says this was not a collision.
   */
  it('is silent when two karts scrape the off-track shoulder nose to tail', () => {
    const rig = makeContactRig({ twinned: true })
    rig.place(rig.listenerSeat, 0.2, 16, 35)
    rig.place(rig.partnerSeat, 0.2 + 2.3 / rig.trackLength, 16, 35)
    rig.arm()
    rig.drive({ ticks: 30, accel: 0, brake: true })

    expect(rig.frames.every((frame) => frame.listenerSurface === 'offtrack')).toBe(true)
    expect(rig.frames.every((frame) => frame.partnerSurface === 'offtrack')).toBe(true)
    expect(minOf(rig.frames.map((frame) => frame.separation))).toBeGreaterThan(
      CONTACT_DIAMETER_M,
    )

    // The trap, armed: an unsigned rule sees the full brake rate on both karts.
    const armed = rig.frames.filter(
      (frame) =>
        Math.min(Math.abs(frame.pushListener), Math.abs(frame.pushPartner))
          > BRAKE_DV_PER_TICK - 0.01
        && frame.separation <= CONTACT_RANGE_M,
    )
    expect(armed.length).toBeGreaterThan(0)
    // Signed, they oppose: one kart closes on the other by exactly as much as
    // the other pulls away, which is what a SHARED direction looks like.
    for (const frame of armed) {
      expect(frame.pushListener * frame.pushPartner).toBeLessThan(0)
    }

    expect(impactsIn(rig.frames)).toHaveLength(0)
    expectDeltaDerived(rig)
    rig.close()
  })

  /**
   * The one arrangement in which two karts genuinely accelerate away from each
   * other without ever touching: facing each other, close, both braking. The
   * geometry test cannot separate this from a bump, and the push floor is what
   * does — `brakeRate * TICK_DT` bounds each kart at 0.8 m/s per tick, measured
   * here at exactly that, and audio.ts's floor sits above it.
   *
   * CATCHES a floor set at or below the brake rate. It is the assertion that
   * makes the floor's value load-bearing rather than decorative: lowering it to
   * 0.8 or below turns this scenario audible.
   */
  it('is silent when two karts brake nose to nose without ever touching', () => {
    const rig = makeContactRig({ twinned: true })
    rig.place(rig.listenerSeat, 0.2, 0, 2, 1)
    rig.place(rig.partnerSeat, 0.2 + 2.45 / rig.trackLength, 0, 2, -1)
    rig.arm()
    rig.drive({ ticks: 12, accel: 0, brake: true })

    // Never touched, and never even left contact range.
    expect(minOf(rig.frames.map((frame) => frame.separation))).toBeGreaterThan(
      CONTACT_DIAMETER_M,
    )
    expect(maxOf(rig.frames.map((frame) => frame.separation))).toBeLessThan(CONTACT_RANGE_M)

    // Both pushes positive, both at the brake rate, on the same frames.
    const mutual = maxOf(
      rig.frames.map((frame) => Math.min(frame.pushListener, frame.pushPartner)),
    )
    expect(mutual).toBeGreaterThan(BRAKE_DV_PER_TICK - 0.01)
    expect(mutual).toBeLessThan(BRAKE_DV_PER_TICK + 0.01)

    expect(impactsIn(rig.frames)).toHaveLength(0)
    expectDeltaDerived(rig)
    rig.close()
  })

  /**
   * A spin-out bleeds 6 % of a kart's horizontal speed every tick and then lets
   * the rotating heading drag the rest of it through `lateralGripFor`. That is a
   * far bigger velocity change than the throttle can make — measured here at
   * 4.2 m/s per kart per frame, nearly five times the push floor, and unlike a
   * ramp launch it lies flat ALONG the line between two karts running nose to
   * tail, inside contact range. Neither the floor nor the range gate can help.
   *
   * CATCHES a rule written on `Math.abs(dv . n)`. What saves it is that both
   * karts lose that speed in the SAME direction, so the signed values are equal
   * and opposite: the kart behind gains on the one in front, which is the
   * signature of a shared effect and never of a collision.
   */
  it('is silent when two karts spin out nose to tail', () => {
    const rig = makeContactRig({ twinned: true })
    rig.place(rig.listenerSeat, 0.2, 0, 35)
    rig.place(rig.partnerSeat, 0.2 + 2.3 / rig.trackLength, 0, 35)
    rig.spinOut(rig.listenerSeat, 60)
    rig.spinOut(rig.partnerSeat, 60)
    rig.arm()
    rig.drive({ ticks: 40, accel: 0 })

    expect(minOf(rig.frames.map((frame) => frame.separation))).toBeGreaterThan(
      CONTACT_DIAMETER_M,
    )
    expect(maxOf(rig.frames.map((frame) => frame.separation))).toBeLessThan(CONTACT_RANGE_M)

    // The trap, armed: an unsigned rule sees several times the floor here, on
    // both karts, on the same frames, projected onto the line between them.
    const armed = rig.frames.filter(
      (frame) =>
        Math.min(Math.abs(frame.pushListener), Math.abs(frame.pushPartner)) > 3,
    )
    expect(armed.length).toBeGreaterThan(0)
    for (const frame of armed) {
      expect(frame.pushListener * frame.pushPartner).toBeLessThan(0)
    }

    expect(impactsIn(rig.frames)).toHaveLength(0)
    expectDeltaDerived(rig)
    rig.close()
  })

  /**
   * The same spin-out, with the pair 40 m apart and pointing AT each other. Now
   * both karts really are losing speed away from the other along the line between
   * them — measured at 4.2 m/s each, with the correct sign on both — so the
   * geometry test and the floor are both satisfied and only the contact range
   * says no. Two karts half a straight apart are not touching, whatever their
   * velocities are doing, and 40 m is well inside `CUE_FALLOFF_M`, so a cue
   * raised here would be plainly audible.
   *
   * CATCHES a rule with no proximity test at all.
   */
  it('is silent when two karts spin out at opposite ends of the straight', () => {
    const rig = makeContactRig({ twinned: true })
    rig.place(rig.listenerSeat, 0.2, 0, 35, 1)
    rig.place(rig.partnerSeat, 0.2 + 40 / rig.trackLength, 0, 35, -1)
    rig.spinOut(rig.listenerSeat, 60)
    rig.spinOut(rig.partnerSeat, 60)
    rig.arm()
    rig.drive({ ticks: 40, accel: 0 })

    // The trap, armed: both signed pushes well above the floor, at once.
    const armed = rig.frames.filter(
      (frame) => Math.min(frame.pushListener, frame.pushPartner) > 3,
    )
    expect(armed.length).toBeGreaterThan(0)
    // ...and nowhere near each other on any frame of the run.
    expect(minOf(rig.frames.map((frame) => frame.separation))).toBeGreaterThan(
      CONTACT_RANGE_M * 4,
    )

    expect(impactsIn(rig.frames)).toHaveLength(0)
    expectDeltaDerived(rig)
    rig.close()
  })
})
