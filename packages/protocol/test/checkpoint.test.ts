import { describe, expect, it } from 'vitest'
import type {
  EntityKind,
  EntityState,
  Intent,
  ItemKind,
  KartState,
  SimState,
  Surface,
} from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, statesEqual } from '@tapkart/sim'
import { decodeCheckpoint, encodeCheckpoint } from '../src/checkpoint'

/** Test-local enum-value pools, independent of checkpoint.ts's internal wire
 * order — this test must pass regardless of how the codec orders its lookup
 * tables internally, as long as encode/decode agree with themselves. */
const ITEM_POOL: ItemKind[] = ['none', 'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge']
const SURFACE_POOL: Surface[] = ['tarmac', 'dirt', 'boost', 'offtrack']
const ENTITY_KIND_POOL: EntityKind[] = ['seeker', 'bolt', 'slick', 'bubble', 'surge', 'charge']

function makeKart(i: number): KartState {
  return {
    playerId: i,
    characterIdx: (i * 3) % 8,
    isBot: i % 2 === 0,
    connected: i % 3 !== 0,
    position: { x: i * 12.5 - 40, y: 0.5, z: -i * 7.25 },
    velocity: { x: i === 0 ? -0 : i * 1.5, y: 0, z: 3.25 - i },
    heading: (i - 4) * 0.4,
    angularVelocity: i % 2 === 0 ? -0.75 : 0.75,
    drift: { active: i % 2 === 1, dir: ((i % 3) - 1) as -1 | 0 | 1, charge: i * 9 },
    item: ITEM_POOL[i % ITEM_POOL.length]!,
    airborne: i === 5,
    surface: SURFACE_POOL[i % SURFACE_POOL.length]!,
    spinOutTicks: i * 4,
    invulnTicks: i * 5,
    boostTicks: i * 3,
    respawnTicks: i * 2,
    shielded: i === 7,
    lap: { lap: i % 4, checkpointIdx: i, t: i / 10 },
  }
}

function makeEntity(i: number): EntityState {
  const alive = i < 5
  return {
    entityId: alive ? 100 + i : -1,
    kind: ENTITY_KIND_POOL[i % ENTITY_KIND_POOL.length]!,
    ownerId: alive ? i % MAX_KARTS : -1,
    position: { x: i * 3.1, y: alive ? 1.2 : 0, z: -i * 2.2 },
    velocity: { x: 0.5 * i, y: 0, z: -0.25 * i },
    heading: (i % 7) * 0.3 - 1,
    targetId: alive ? (i + 1) % MAX_KARTS : -1,
    ttl: alive ? 600 - i * 10 : 0,   // 600 = Tuning.entityTtl's max, contract $1c
  }
}

function makeHeldIntent(i: number): Intent {
  return { tick: 100 + i, steer: (i - 4) / 8, accel: i % 2, brake: i === 3, drift: i === 5, useItem: i === 6 }
}

const richState: SimState = {
  tick: 4211,
  phase: 'racing',
  raceSeed: 0x1234abcd,
  rngCursor: 987654,
  nextEventSeq: 321,
  finishTick: -1,
  entityCount: 5,
  nextEntityId: 137,
  karts: Array.from({ length: MAX_KARTS }, (_, i) => makeKart(i)),
  entities: Array.from({ length: MAX_ENTITIES }, (_, i) => makeEntity(i)),
  itemBoxes: [
    { boxIdx: 0, respawnTicks: 0 },
    { boxIdx: 1, respawnTicks: 45 },
    { boxIdx: 2, respawnTicks: 0 },
    { boxIdx: 3, respawnTicks: 180 },
  ],
  finishedOrder: [3, -1, -1, -1, -1, -1, -1, -1],
  heldBotIntent: Array.from({ length: MAX_KARTS }, (_, i) => makeHeldIntent(i)),
  heldBotTick: [-1, 12, -1, 45, -1, 7, -1, 3],
}

/** Same shape as `src` (same array lengths throughout), every value
 * different, so the round-trip test is meaningful rather than vacuous. */
function makeBlankLike(src: SimState): SimState {
  return {
    tick: 0,
    phase: 'countdown',
    raceSeed: 0,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: 0,
    entityCount: 0,
    nextEntityId: 0,
    karts: src.karts.map(() => ({
      playerId: 0,
      characterIdx: 0,
      isBot: false,
      connected: false,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      angularVelocity: 0,
      drift: { active: false, dir: 0 as const, charge: 0 },
      item: 'none' as const,
      airborne: false,
      surface: 'tarmac' as const,
      spinOutTicks: 0,
      invulnTicks: 0,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
      lap: { lap: 0, checkpointIdx: 0, t: 0 },
    })),
    entities: src.entities.map(() => ({
      entityId: 0,
      kind: 'seeker' as const,
      ownerId: 0,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      targetId: 0,
      ttl: 0,
    })),
    itemBoxes: src.itemBoxes.map(() => ({ boxIdx: 0, respawnTicks: 0 })),
    finishedOrder: src.finishedOrder.map(() => 0),
    heldBotIntent: src.heldBotIntent.map(() => ({
      tick: 0,
      steer: 0,
      accel: 0,
      brake: false,
      drift: false,
      useItem: false,
    })),
    heldBotTick: src.heldBotTick.map(() => 0),
  }
}

describe('checkpoint round trip', () => {
  it('is bit-identical for a fully populated SimState, per statesEqual', () => {
    const buf = new Uint8Array(6000)
    const n = encodeCheckpoint(buf, richState)

    // 8 header fields + 8 karts * 26 fields + 32 entities * 12 fields
    // + (1 count + 4 boxes * 2 fields) + 8 finishedOrder
    // + 8 heldBotIntent * 6 fields + 8 heldBotTick, all at 8 bytes/field:
    // (8 + 8*26 + 32*12 + 1 + 4*2 + 8 + 8*6 + 8) * 8 = 5384
    expect(n).toBe(5384)

    const dst = makeBlankLike(richState)
    expect(statesEqual(dst, richState)).toBe(false) // the placeholder really differs

    decodeCheckpoint(buf.subarray(0, n), dst)

    expect(statesEqual(dst, richState)).toBe(true)

    // statesEqual returns a bare boolean; name the fields too, per this
    // plan's style (Task 16), so a failure says which kart/entity/quantity.
    for (let i = 0; i < MAX_KARTS; i++) {
      const a = dst.karts[i]!
      const b = richState.karts[i]!
      expect(Object.is(a.position.x, b.position.x)).toBe(true)
      expect(Object.is(a.position.y, b.position.y)).toBe(true)
      expect(Object.is(a.position.z, b.position.z)).toBe(true)
      expect(Object.is(a.velocity.x, b.velocity.x)).toBe(true)
      expect(Object.is(a.heading, b.heading)).toBe(true)
      expect(Object.is(a.angularVelocity, b.angularVelocity)).toBe(true)
      expect(Object.is(a.drift.charge, b.drift.charge)).toBe(true)
      expect(a.drift.dir).toBe(b.drift.dir)
      expect(a.item).toBe(b.item)
      expect(a.surface).toBe(b.surface)
      expect(a.boostTicks).toBe(b.boostTicks)
      expect(a.respawnTicks).toBe(b.respawnTicks)
      expect(a.shielded).toBe(b.shielded)
      expect(Object.is(a.lap.t, b.lap.t)).toBe(true)
    }
    for (let i = 0; i < MAX_ENTITIES; i++) {
      expect(Object.is(dst.entities[i]!.entityId, richState.entities[i]!.entityId)).toBe(true)
      expect(dst.entities[i]!.kind).toBe(richState.entities[i]!.kind)
      expect(Object.is(dst.entities[i]!.ttl, richState.entities[i]!.ttl)).toBe(true)
    }

    // The specific defect this task exists to prevent: heldBotIntent and
    // heldBotTick (Plan 2 Task 1) must be carried. Dropping them would
    // resurrect the cross-room bot-hold bug Task 1 exists to fix.
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(dst.heldBotIntent[i]).toEqual(richState.heldBotIntent[i])
      expect(Object.is(dst.heldBotTick[i], richState.heldBotTick[i])).toBe(true)
    }

    // -0 survives a raw float64 round trip, not just === 0.
    expect(Object.is(dst.karts[0]!.velocity.x, -0)).toBe(true)
  })

  it('writes an independent copy: mutating dst does not affect the source state', () => {
    const buf = new Uint8Array(6000)
    const n = encodeCheckpoint(buf, richState)
    const dst = makeBlankLike(richState)
    decodeCheckpoint(buf.subarray(0, n), dst)

    dst.karts[0]!.position.x += 1000
    expect(richState.karts[0]!.position.x).not.toBe(dst.karts[0]!.position.x)
  })

  it('throws if dst.itemBoxes.length disagrees with the encoded count', () => {
    const buf = new Uint8Array(6000)
    const n = encodeCheckpoint(buf, richState) // encoded with 4 item boxes
    const dst = makeBlankLike(richState)
    dst.itemBoxes.pop() // now 3; the buffer says 4

    expect(() => decodeCheckpoint(buf.subarray(0, n), dst)).toThrow(/itemBoxes/)
  })
})

describe('decodeCheckpoint checks the length before it writes a byte (item E)', () => {
  /**
   * A checkpoint's encoded size is a pure function of the destination's shape -
   * every field is one fixed-width float64 and nothing is variable-length - so
   * the whole TRUNCATION case can be eliminated up front, which is the case that
   * is actually reachable off a socket.
   *
   * It used to be caught, if at all, by `DataView.getFloat64` running off the end
   * AFTER the header and however many karts fit had already been overwritten.
   * ShadowLoop measured where that goes: a good checkpoint followed by a
   * truncated one in the same window landed `live` on tick 9001, a tick the host
   * never reached, with a kart 80 m from where either checkpoint put it.
   *
   * Not corrupting `dst` at all in every case would need a second full SimState
   * of scratch per decode; the length check removes the reachable case without
   * it, and the codec's docstring now says which case remains (a right-length
   * buffer carrying a bad enum still writes the fields ahead of it).
   */
  it('rejects a truncated buffer without touching dst', () => {
    const buf = new Uint8Array(6000)
    const n = encodeCheckpoint(buf, richState)
    const dst = makeBlankLike(richState)
    dst.tick = -1
    const before = dst.karts[0]!.position.x

    // One float64 short - the shape a datagram cut off in flight has.
    expect(() => decodeCheckpoint(buf.subarray(0, n - 8), dst)).toThrow(RangeError)
    expect(dst.tick, 'a truncated checkpoint wrote the header before failing').toBe(-1)
    expect(dst.karts[0]!.position.x, 'a truncated checkpoint wrote kart fields before failing').toBe(before)
  })

  it('rejects a buffer that is one field too long', () => {
    // The other side of "exact". A frame with trailing bytes is not a frame this
    // encoder produced, and reading only the prefix would decode a message this
    // build does not understand as if it did.
    const buf = new Uint8Array(6000)
    const n = encodeCheckpoint(buf, richState)
    const dst = makeBlankLike(richState)
    expect(() => decodeCheckpoint(buf.subarray(0, n + 8), dst)).toThrow(RangeError)
  })

  it('names the shape that disagreed, so the itemBoxes mismatch is still legible', () => {
    // The up-front check subsumes the boxCount check further down - which could
    // only ever fire after everything ahead of it had been overwritten - so the
    // error it raises has to carry the same diagnosis.
    const buf = new Uint8Array(6000)
    const n = encodeCheckpoint(buf, richState)
    const dst = makeBlankLike(richState)
    dst.tick = -1
    dst.itemBoxes.pop()
    expect(() => decodeCheckpoint(buf.subarray(0, n), dst)).toThrow(/itemBoxes/)
    expect(dst.tick, 'the shape mismatch was found only after the header was overwritten').toBe(-1)
  })

  it('the size the check computes is the size the encoder writes, for every shape', () => {
    // The check is only as good as its field table, and that table is the one
    // duplication of encodeCheckpoint's field list. encodeCheckpoint asserts
    // against it on every call, so this is that assertion exercised across
    // shapes that differ in each of the terms.
    const shapes = [richState, makeBlankLike(richState)]
    for (const s of shapes) {
      const buf = new Uint8Array(8192)
      const n = encodeCheckpoint(buf, s)
      const dst = makeBlankLike(s)
      expect(() => decodeCheckpoint(buf.subarray(0, n), dst)).not.toThrow()
    }
    // A destination with a different item-box count is a different shape, and
    // must be rejected rather than silently read short.
    const fewerBoxes = makeBlankLike(richState)
    fewerBoxes.itemBoxes.pop()
    const buf = new Uint8Array(8192)
    const nFewer = encodeCheckpoint(buf, fewerBoxes)
    expect(nFewer).toBe(encodeCheckpoint(new Uint8Array(8192), richState) - 16)
  })
})
