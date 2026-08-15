// The golden run for the NETWORKED stack: a recorded input stream, replayed through a real
// AuthorityLoop, a real ClientLoop and a real ShadowLoop over three lossy links, compared to a
// stored expectation FIELD BY FIELD.
//
// Spec §8's `sim` row already does this for `step()` alone. This is the same instrument pointed at
// everything Plan 2 added between a player's thumb and the authoritative world: encodeInput /
// decodeInput, the 30Hz-into-60Hz hold, encodeSnapshot / decodeSnapshot, the reconciler, the event
// stream, and the shadow's follower-mode correction path. Any of those changing its behaviour moves
// a stored number here, and the diff names the field, both values, the delta and the tolerance.
//
// It is a golden COMPARISON, not a digest: spec §8, "hashing float state produces a test that fails
// informatively never and mysteriously often." The comparison machinery is Plan 1's
// (`diffAgainstGolden`), reached by relative path exactly as `net-fixtures.ts` reaches
// `track-fixtures.ts` - both live under `sim/test`, which sim's production barrel never re-exports.
//
// Determinism: nothing in this stack reads a wall clock. `LoopbackTransport` is pumped with a
// caller-supplied `nowMs`, jitter and loss come from `rngAt(seed, cursor)` on a per-link seed, and
// the sim is the same deterministic step() Plan 1 golden-tests. So two runs of this file in one
// process are identical, and the recorded stream reproduces the run it was recorded from.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Intent, SimContext, SimState } from '@tapkart/sim'
import { botIntent, createState } from '@tapkart/sim'
import { decodeHeader } from '@tapkart/protocol'

import { AuthorityLoop } from '../../src/authority'
import { ClientLoop } from '../../src/client'
import { ShadowLoop } from '../../src/shadow'
import { TICK_MS } from '../../src/clock'
import { droppedDatagramsOf } from '../../src/receive'
import { MESH_LINK_SEEDS, makeThreeWayMesh } from './mesh'
import { makeNetContext } from './net-fixtures'
import { spyTransport } from './spy-transport'

import type { GoldenExpectation } from '../../../sim/test/fixtures/golden-format'
import {
  INTENT_BYTES_PER_KART,
  INTENT_SCALE,
  decodeB64Lines,
  encodeB64Lines,
  normZero,
  quantizeIntent,
} from '../../../sim/test/fixtures/golden-format'

export const GOLDEN_NET_FORMAT_VERSION = 1

/** Fixed forever; changing it invalidates the fixture. */
export const GOLDEN_NET_SEED = 0x20260814

/**
 * All-zero, and not `[0, 1, ..., 7]`, because `ClientLoop` bootstraps its own state with
 * `characterIdx` all zero - there is no lobby handshake in this plan to tell it otherwise. A host
 * built with eight different characters runs seats 1-7 on different `CharacterStats` from the ones
 * the guest simulates, and the two worlds drift apart for a reason that has nothing to do with the
 * netcode under test.
 */
export const GOLDEN_NET_CHARACTER_IDX: number[] = [0, 0, 0, 0, 0, 0, 0, 0]

/** The seat the recorded stream drives. Every other seat is a bot on all three peers. */
export const GOLDEN_NET_PLAYER_ID = 0

/**
 * 20s at 60Hz. Long enough for several laps, item grants, entity spawns and despawns, hundreds of
 * snapshots and a working reconciler; short enough that the golden run costs about a second.
 */
export const GOLDEN_NET_TICKS = 1200

/** Spec §8's network conditions, stored in the fixture so a change of profile is visible in a diff. */
export const GOLDEN_NET_PROFILE = { latencyMs: 150, jitterMs: 50, lossRate: 0.05 } as const

/**
 * The command that actually regenerates the fixture - `golden-net-regen.test.ts`, NOT
 * `golden-run.test.ts`, which this string used to name.
 *
 * That was not cosmetic. This is the one instruction a stuck maintainer follows: it is stored in
 * every fixture's `generatedBy`, asserted by the metadata test, and printed in the formatVersion
 * mismatch error. Run as written, with `UPDATE_GOLDEN=1`, it left the fixture byte-identical and
 * reported 12 passing tests - a command that looks like it worked and writes nothing, aimed at
 * someone whose fixture is already broken. The regenerator lives in its own file precisely so a
 * missing fixture cannot take it down (see the header of `golden-run.test.ts`), which is what made
 * the wrong name plausible.
 */
export const GOLDEN_NET_REGEN_COMMAND =
  'UPDATE_GOLDEN=1 npx vitest run packages/net/test/golden-net-regen.test.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

export const GOLDEN_NET_PATH = join(HERE, 'golden-net-run.json')

export interface GoldenNetCounters {
  /** Corrections the guest's reconciler applied across the whole run. */
  corrections: number
  snapshotsToClient: number
  snapshotsToShadow: number
  eventDatagramsToClient: number
  eventDatagramsToShadow: number
  /** Undecodable datagrams. Every peer must report 0: both ends are this build. */
  droppedHost: number
  droppedClient: number
  droppedShadow: number
  hostEventSeq: number
  clientEventSeq: number
  shadowEventSeq: number
}

export interface GoldenNetFixture {
  formatVersion: number
  /** The command that regenerates this file. No timestamps, no hostnames, no absolute paths. */
  generatedBy: string
  trackId: string
  raceSeed: number
  characterIdx: number[]
  drivenPlayerId: number
  tickCount: number
  intentScale: number
  transport: {
    latencyMs: number
    jitterMs: number
    lossRate: number
    hostClientSeed: number
    hostShadowSeed: number
    clientShadowSeed: number
  }
  intentsB64: string[]
  counters: GoldenNetCounters
  /** The authoritative world at the last tick. */
  host: GoldenExpectation
  /** The guest's predicted world at the same tick - its own kart is the part that matters. */
  client: GoldenExpectation
  /** The server shadow's published world at the same tick. */
  shadow: GoldenExpectation
}

export interface GoldenNetRun {
  host: SimState
  client: SimState
  shadow: SimState
  /** The stream that was played, quantised to the fixture grid - recorded or replayed. */
  intents: Intent[]
  counters: GoldenNetCounters
}

/**
 * One seat's recorded stream: int16 steer + int16 accel + uint8 flags per tick, the same packing
 * Plan 1's golden fixture uses per kart. Only one seat is human in this run, so storing all eight
 * would be 40 bytes a tick of zeros.
 */
export function packSeatIntents(intents: Intent[]): Uint8Array {
  const bytes = new Uint8Array(intents.length * INTENT_BYTES_PER_KART)
  const dv = new DataView(bytes.buffer)
  for (let t = 0; t < intents.length; t++) {
    const off = t * INTENT_BYTES_PER_KART
    const it = intents[t]
    dv.setInt16(off, normZero(Math.round(it.steer * INTENT_SCALE)), true)
    dv.setInt16(off + 2, normZero(Math.round(it.accel * INTENT_SCALE)), true)
    dv.setUint8(off + 4, (it.brake ? 1 : 0) | (it.drift ? 2 : 0) | (it.useItem ? 4 : 0))
  }
  return bytes
}

export function unpackSeatIntents(bytes: Uint8Array, tickCount: number): Intent[] {
  const need = tickCount * INTENT_BYTES_PER_KART
  if (bytes.length !== need) {
    throw new Error(`golden-net: intent stream is ${bytes.length} bytes, expected ${need} for ${tickCount} ticks`)
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Intent[] = []
  for (let t = 0; t < tickCount; t++) {
    const off = t * INTENT_BYTES_PER_KART
    const flags = dv.getUint8(off + 4)
    out.push({
      tick: t,
      steer: dv.getInt16(off, true) / INTENT_SCALE,
      accel: dv.getInt16(off + 2, true) / INTENT_SCALE,
      brake: (flags & 1) !== 0,
      drift: (flags & 2) !== 0,
      useItem: (flags & 4) !== 0,
    })
  }
  return out
}

/**
 * The start state every peer's own copy of the world begins from.
 *
 * THE RUN STARTS IN 'racing', AND DOES NOT CROSS THE START LINE. That is a deliberate choice about
 * what a golden fixture is allowed to freeze, not an oversight: a live defect in Task 15c's phase
 * adoption (`ClientLoop.tick()` adopts `snap.phase` unconditionally, and a snapshot in flight is
 * ~9 ticks old at 150ms, so a guest just past the lights adopts a stale `'countdown'` and discards
 * one tick of input) makes the countdown->racing boundary record a known-wrong flicker. A fixture
 * that captured it would make the bug permanent and make its fix look like a regression. The
 * boundary is covered by `client.test.ts`'s dedicated phase tests and by the fix's own round; this
 * run stays inside the steady state, where every stored number is a number the code is supposed to
 * produce.
 *
 * The guest still learns `'racing'` from the wire - it bootstraps its own state in `'countdown'` and
 * has no other way to be told - so the adoption path is exercised in the one direction that is
 * unambiguously correct.
 */
function makeRaceState(ctx: SimContext): SimState {
  const s = createState(ctx, GOLDEN_NET_SEED, GOLDEN_NET_CHARACTER_IDX)
  s.phase = 'racing'
  // The one human seat. `createState` defaults every kart to `isBot: true, connected: false`, and
  // `resolveInputs` routes any !connected kart through bot AI - so without these two lines the
  // authority would ignore the recorded stream entirely and drive kart 0 itself.
  s.karts[GOLDEN_NET_PLAYER_ID].isBot = false
  s.karts[GOLDEN_NET_PLAYER_ID].connected = true
  return s
}

function copyIntent(src: Intent): Intent {
  return { tick: src.tick, steer: src.steer, accel: src.accel, brake: src.brake, drift: src.drift, useItem: src.useItem }
}

/**
 * The full stack, for `ticks` ticks.
 *
 * `recorded === null` RECORDS: seat 0's intent comes from `botIntent` against the authoritative
 * state, recomputed on even ticks and held on odd ones (spec §5's 30Hz input into a 60Hz sim), and
 * is quantised to the fixture grid BEFORE it is played - so the stream that gets stored is
 * byte-identical to the stream that produced the stored expectation. Otherwise it REPLAYS the
 * stream it is handed and never calls `botIntent` at all.
 *
 * Recording and replaying share this one function on purpose: a recorder that differed from the
 * replayer anywhere - by a tick of ordering, by a pump, by which state it read - would produce a
 * fixture that could never be reproduced, and the failure would look like a netcode regression.
 */
export function runGoldenNet(recorded: Intent[] | null, ticks: number = GOLDEN_NET_TICKS): GoldenNetRun {
  if (recorded !== null && recorded.length < ticks) {
    throw new Error(`golden-net: stream has ${recorded.length} rows, need ${ticks}`)
  }
  const hostCtx = makeNetContext(true)
  const clientCtx = makeNetContext(false)
  const shadowCtx = makeNetContext(false)
  const hostState = makeRaceState(hostCtx)
  const shadowState = makeRaceState(shadowCtx)

  const mesh = makeThreeWayMesh(GOLDEN_NET_PROFILE)
  let snapshotsToClient = 0
  let snapshotsToShadow = 0
  let eventDatagramsToClient = 0
  let eventDatagramsToShadow = 0
  const clientTransport = spyTransport(mesh.client, (_peerId, channel, data) => {
    const kind = decodeHeader(data).kind
    if (channel === 'unreliable' && kind === 'snapshot') snapshotsToClient++
    if (channel === 'reliable' && kind === 'events') eventDatagramsToClient++
  })
  const shadowTransport = spyTransport(mesh.shadow, (_peerId, channel, data) => {
    const kind = decodeHeader(data).kind
    if (channel === 'unreliable' && kind === 'snapshot') snapshotsToShadow++
    if (channel === 'reliable' && kind === 'events') eventDatagramsToShadow++
  })

  const host = new AuthorityLoop(hostCtx, hostState, mesh.host)
  const client = new ClientLoop(clientCtx, GOLDEN_NET_PLAYER_ID, clientTransport)
  const shadow = new ShadowLoop(shadowCtx, shadowState, shadowTransport)

  const intents: Intent[] = []
  const held: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
  let nowMs = 0

  for (let t = 0; t < ticks; t++) {
    let intent: Intent
    if (recorded === null) {
      if (t % 2 === 0) {
        const raw = botIntent(hostCtx, hostState, GOLDEN_NET_PLAYER_ID)
        held.steer = raw.steer
        held.accel = raw.accel
        held.brake = raw.brake
        held.drift = raw.drift
        held.useItem = raw.useItem
      }
      intent = quantizeIntent(held, t)
    } else {
      intent = copyIntent(recorded[t])
      intent.tick = t
    }
    intents.push(intent)

    host.tick()
    client.tick(intent)
    shadow.tick(nowMs)
    mesh.pump(nowMs)
    nowMs += TICK_MS
  }

  return {
    host: hostState,
    client: client.state(),
    shadow: shadowState,
    intents,
    counters: {
      corrections: client.corrections(),
      snapshotsToClient,
      snapshotsToShadow,
      eventDatagramsToClient,
      eventDatagramsToShadow,
      droppedHost: droppedDatagramsOf(host),
      droppedClient: droppedDatagramsOf(client),
      droppedShadow: droppedDatagramsOf(shadow),
      hostEventSeq: hostState.nextEventSeq,
      clientEventSeq: client.state().nextEventSeq,
      shadowEventSeq: shadowState.nextEventSeq,
    },
  }
}

/** Replays the stream stored in `fx`, over the transport `fx` was recorded on. */
export function replayGoldenNet(fx: GoldenNetFixture): GoldenNetRun {
  return runGoldenNet(unpackSeatIntents(decodeB64Lines(fx.intentsB64), fx.tickCount), fx.tickCount)
}

export function encodeGoldenNetIntents(intents: Intent[]): string[] {
  return encodeB64Lines(packSeatIntents(intents))
}

export function readGoldenNetFixtureText(path: string = GOLDEN_NET_PATH): string {
  return readFileSync(path, 'utf8')
}

export function loadGoldenNetFixture(path: string = GOLDEN_NET_PATH): GoldenNetFixture {
  const fx = JSON.parse(readGoldenNetFixtureText(path)) as GoldenNetFixture
  if (fx.formatVersion !== GOLDEN_NET_FORMAT_VERSION) {
    throw new Error(
      `golden-net: fixture formatVersion ${fx.formatVersion}, this build expects ` +
        `${GOLDEN_NET_FORMAT_VERSION}. Regenerate it with: ${GOLDEN_NET_REGEN_COMMAND}`,
    )
  }
  return fx
}

export function saveGoldenNetFixture(fx: GoldenNetFixture, path: string = GOLDEN_NET_PATH): void {
  writeFileSync(path, `${JSON.stringify(fx, null, 2)}\n`, 'utf8')
}

/** The transport block every recorded run carries, from the constants the run actually used. */
export function goldenNetTransportBlock(): GoldenNetFixture['transport'] {
  return {
    latencyMs: GOLDEN_NET_PROFILE.latencyMs,
    jitterMs: GOLDEN_NET_PROFILE.jitterMs,
    lossRate: GOLDEN_NET_PROFILE.lossRate,
    hostClientSeed: MESH_LINK_SEEDS.hostClient,
    hostShadowSeed: MESH_LINK_SEEDS.hostShadow,
    clientShadowSeed: MESH_LINK_SEEDS.clientShadow,
  }
}
