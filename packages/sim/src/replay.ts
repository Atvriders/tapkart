/**
 * Deterministic run recorder and replayer.
 *
 * WHY THE EQUIVALENCE TEST IS SAME-PROCESS ONLY, AND WHY THAT IS ENOUGH
 *
 * IEEE-754 makes `+ - * / sqrt` bit-exactly reproducible on every conforming
 * engine: the standard specifies correctly-rounded results. `Math.sin`,
 * `Math.cos`, `Math.atan2` and `Math.pow` are not in that category. ECMA-262
 * explicitly declines to specify their precision — an implementation may use
 * any approximation of the mathematical function, with fdlibm recommended and
 * not required. V8, JavaScriptCore and SpiderMonkey use different kernels and
 * different argument-reduction paths, and V8 has changed its own `Math.sin`
 * across releases. One ULP of difference in `Math.cos(heading)` on tick one
 * becomes metres of separation a few hundred ticks later, because the
 * integrator feeds its own output back in.
 *
 * This sim calls `Math.cos`/`Math.sin` for every kart on every tick — the
 * contract fixes `forward = (cos h, 0, sin h)` — and `Math.atan2` wherever a
 * heading is derived from a direction. Cross-engine bit-identity is therefore
 * unavailable, and no test discipline creates it; you would need fixed-point or
 * a software transcendental library, which is what lockstep RTS games ship.
 *
 * It is also unnecessary. Tapkart is snapshot + reconciliation, not lockstep.
 * The authority alone decides what happened; clients predict locally and are
 * corrected against `WireSnapshot`, which is quantized to ~21 bytes per kart and
 * lossy by construction — a client is already being pulled onto values it did
 * not compute, twenty times a second, by design. Nothing in the netcode compares
 * two independently-simulated float streams across two machines for equality.
 *
 * What the same-process test does prove is the property reconciliation is built
 * on: restoring a SimState and replaying inputs reproduces the state exactly.
 * A client that rewinds to an authoritative checkpoint and replays its buffered
 * inputs then lands on precisely the state the authority computed, so a
 * correction settles instead of oscillating.
 *
 * CHECKPOINT PARITY INVARIANT
 *
 * Task 15's 30Hz bot hold is the one piece of simulation state outside
 * SimState, and therefore outside cloneState and statesEqual: bots recompute an
 * Intent only on even ticks and the odd tick of the pair reuses it. A checkpoint
 * at tick T replays bit-identically for any T when no kart is bot-driven. With
 * bots or disconnected karts present, T must be ODD, so the first replayed step
 * produces the even tick T+1 and recomputes bot intents from scratch. On an even
 * T the first replayed step produces an odd tick, which in the straight-through
 * run reused an intent derived from the kart data as it stood at the START of
 * tick T — data a checkpoint taken at the END of tick T does not contain.
 * Authority checkpoints are emitted on odd ticks.
 *
 * `replayRun` enforces this at runtime (see `needsOddCheckpoint`), not just in
 * this comment: an even-T checkpoint with a bot-driven or disconnected kart
 * outside the countdown phase throws a RangeError instead of silently
 * diverging. `resolveInputs` freezes every kart during countdown before it ever
 * looks at `isBot`/`connected`, so the hold is never touched there and an even
 * countdown-phase checkpoint is accepted at any parity.
 */
import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { cloneState, createState } from './state'
import { step } from './step'
import { makeIntentBuffer, resetBotHold } from './phase'

/** Doubles of header at the front of a recording. */
export const INTENT_HEADER = 4
/** Doubles per (tick, slot) intent: steer, accel, brake, drift, useItem. */
export const INTENT_STRIDE = 5

/**
 * Index of the first double of the intent recorded for kart slot `slot` at
 * pre-step tick `tick`. Row `t` holds the intents fed to the step that consumes
 * the state at tick `t` and produces tick `t + 1`.
 */
export function intentOffset(intents: Float64Array, tick: number, slot: number): number {
  const baseTick = intents[0]
  return INTENT_HEADER + ((tick - baseTick) * MAX_KARTS + slot) * INTENT_STRIDE
}

/**
 * A brand-new SimState holding a deep copy of `src`. `createState` is the only
 * constructor that builds the fixed-size karts/entities/itemBoxes arrays, so it
 * builds the shape and `cloneState` fills in every value.
 */
export function allocStateLike(ctx: SimContext, src: SimState): SimState {
  const characterIdx: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) characterIdx.push(src.karts[i].characterIdx)
  const s = createState(ctx, src.raceSeed, characterIdx)
  cloneState(src, s)
  return s
}

/** Anything that can answer "what did this player do on this tick". */
export interface IntentSource {
  intentFor(state: SimState, playerId: number): Intent
}

/**
 * True when restoring `state` and replaying forward would actually reach
 * Task 15's bot path (and therefore the 30Hz hold outside SimState) on the very
 * next tick — i.e. the checkpoint parity invariant binds.
 *
 * Mirrors `resolveInputs`'s own short-circuit order exactly, not just its
 * per-kart condition: `resolveInputs` checks `state.phase === 'countdown'`
 * FIRST and, when true, freezes every kart to all-zero and `continue`s before
 * ever looking at `isBot`/`connected` — so during countdown no kart's intent
 * comes from `botIntent`, no matter how many karts are bot-driven or
 * disconnected, and the hold is never touched. Only outside countdown does
 * `k.isBot || !k.connected` route a kart through the hold.
 */
function needsOddCheckpoint(state: SimState): boolean {
  if (state.phase === 'countdown') return false
  for (let i = 0; i < state.karts.length; i++) {
    const k = state.karts[i]
    if (k.isBot || !k.connected) return true
  }
  return false
}

/**
 * Run `ticks` steps from `from`, recording every raw Intent into a flat
 * Float64Array. `from` is never mutated; `end` is a fresh detached state.
 *
 * The raw intents are recorded, not the resolved ones: what a replay must
 * reproduce is the input that arrived, and `resolveInputs` (countdown freeze,
 * bot fill, clamping) is part of the simulation, not part of the input.
 */
export function recordRun(
  ctx: SimContext,
  from: SimState,
  ticks: number,
  src: IntentSource,
): { end: SimState; intents: Float64Array } {
  const baseTick = from.tick
  const intents = new Float64Array(INTENT_HEADER + ticks * MAX_KARTS * INTENT_STRIDE)
  intents[0] = baseTick
  intents[1] = ticks
  intents[2] = MAX_KARTS
  intents[3] = INTENT_STRIDE

  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  // Task 15's 30Hz bot hold is module-level state outside SimState. A run must
  // start from a cold hold or it inherits the previous run's last bot intent.
  resetBotHold()

  for (let n = 0; n < ticks; n++) {
    const t = a.tick
    const row = INTENT_HEADER + (t - baseTick) * MAX_KARTS * INTENT_STRIDE
    for (let slot = 0; slot < MAX_KARTS; slot++) {
      const it = src.intentFor(a, a.karts[slot].playerId)
      const o = row + slot * INTENT_STRIDE
      intents[o] = it.steer
      intents[o + 1] = it.accel
      intents[o + 2] = it.brake ? 1 : 0
      intents[o + 3] = it.drift ? 1 : 0
      intents[o + 4] = it.useItem ? 1 : 0

      const dst = inputs[slot]
      dst.tick = t + 1
      dst.steer = it.steer
      dst.accel = it.accel
      dst.brake = it.brake
      dst.drift = it.drift
      dst.useItem = it.useItem
    }
    events.length = 0   // events are not part of the recording; drop them
    step(ctx, a, b, inputs, events)
    const tmp = a
    a = b
    b = tmp
  }

  return { end: a, intents }
}

/**
 * Restore `from` (a full-precision checkpoint at tick `fromTick`) and replay the
 * recorded intents forward to `toTick`. `from` is never mutated; the returned
 * state is a fresh object.
 */
export function replayRun(
  ctx: SimContext,
  from: SimState,
  intents: Float64Array,
  fromTick: number,
  toTick: number,
): SimState {
  const baseTick = intents[0]
  const rows = intents[1]

  if (from.tick !== fromTick) {
    throw new RangeError(
      `replayRun: checkpoint is at tick ${from.tick} but fromTick is ${fromTick}`,
    )
  }
  if (toTick < fromTick) {
    throw new RangeError(`replayRun: toTick ${toTick} is before fromTick ${fromTick}`)
  }
  if (fromTick < baseTick || toTick > baseTick + rows) {
    throw new RangeError(
      `replayRun: [${fromTick}, ${toTick}] is outside the recorded range ` +
        `[${baseTick}, ${baseTick + rows}]`,
    )
  }
  if (fromTick % 2 !== 1 && needsOddCheckpoint(from)) {
    throw new RangeError(
      `replayRun: checkpoint at tick ${fromTick} is even, but a bot-driven or ` +
        `disconnected kart is active (phase is '${from.phase}', not 'countdown'). ` +
        `Task 15's 30Hz bot-intent hold lives outside SimState, so cloneState/ ` +
        `allocStateLike cannot capture it: replaying from an even tick would ` +
        `silently recompute a different intent than the straight-through run used ` +
        `for the next (odd) tick, and the two runs would diverge with no error. ` +
        `Take authority checkpoints on odd ticks whenever any kart is bot-driven ` +
        `or disconnected.`,
    )
  }

  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  // Same reason as recordRun: start from a cold 30Hz bot hold. See the
  // checkpoint parity invariant in the file header.
  resetBotHold()

  while (a.tick < toTick) {
    const row = INTENT_HEADER + (a.tick - baseTick) * MAX_KARTS * INTENT_STRIDE
    for (let slot = 0; slot < MAX_KARTS; slot++) {
      const o = row + slot * INTENT_STRIDE
      const dst = inputs[slot]
      dst.tick = a.tick + 1
      dst.steer = intents[o]
      dst.accel = intents[o + 1]
      dst.brake = intents[o + 2] !== 0
      dst.drift = intents[o + 3] !== 0
      dst.useItem = intents[o + 4] !== 0
    }
    events.length = 0
    step(ctx, a, b, inputs, events)
    const tmp = a
    a = b
    b = tmp
  }

  return a
}
