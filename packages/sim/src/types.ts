export type Vec3 = { x: number; y: number; z: number }

export const TICK_HZ = 60
export const TICK_DT = 1 / 60
export const MAX_KARTS = 8
export const MAX_ENTITIES = 32
export const RACE_LAPS = 3
export const COUNTDOWN_TICKS = 180

export type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'
export type ItemKind =
  | 'none' | 'boost' | 'seeker' | 'bolt' | 'slick'
  | 'bubble' | 'surge' | 'blink' | 'charge'
export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
export type RacePhase = 'countdown' | 'racing' | 'finished'

export interface Intent {
  tick: number
  steer: number      // -1..1
  accel: number      // 0..1
  brake: boolean
  drift: boolean
  useItem: boolean
}

export interface DriftState { active: boolean; dir: -1 | 0 | 1; charge: number }

export interface LapProgress { lap: number; checkpointIdx: number; t: number }

export interface KartState {
  playerId: number
  characterIdx: number
  isBot: boolean
  connected: boolean
  position: Vec3
  velocity: Vec3
  heading: number
  angularVelocity: number
  drift: DriftState
  item: ItemKind
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  lap: LapProgress
}

export interface EntityState {
  entityId: number
  kind: EntityKind
  ownerId: number
  position: Vec3
  velocity: Vec3
  heading: number
  targetId: number
  ttl: number
}

export interface ItemBoxState { boxIdx: number; respawnTicks: number }

export interface SimState {
  tick: number
  phase: RacePhase
  raceSeed: number
  rngCursor: number
  nextEventSeq: number
  finishTick: number            // -1 until the first kart finishes
  karts: KartState[]            // always length MAX_KARTS
  entities: EntityState[]       // always length MAX_ENTITIES, live ones packed at the front
  entityCount: number
  nextEntityId: number
  itemBoxes: ItemBoxState[]
  finishedOrder: number[]
}

export type AuthEventKind =
  | 'itemGrant' | 'entitySpawn' | 'entityDespawn'
  | 'hit' | 'spinOut' | 'respawn' | 'lapCross' | 'finish'

export interface AuthEvent {
  eventSeq: number
  tick: number
  kind: AuthEventKind
  playerId: number
  entityId: number     // -1 when not applicable
  item: ItemKind       // 'none' when not applicable
  data: number         // kind-specific scalar, 0 when unused
}

export interface TrackPoint {
  position: Vec3
  width: number
  banking: number
  surface: Surface
}

export interface Track {
  id: string
  name: string
  controlPoints: TrackPoint[]
  checkpointS: number[]
  itemBoxes: { s: number; lateral: number }[]
  ramps: { sStart: number; sEnd: number; launch: number }[]
  boostPads: { s: number; lateral: number; halfWidth: number }[]
  startPositions: { s: number; lateral: number }[]
  bounds: { min: Vec3; max: Vec3 }
}

export interface CharacterStats {
  id: string
  name: string
  speed: number
  accel: number
  handling: number
  weight: number
}

export interface Tuning {
  maxSpeed: number
  accelRate: number
  brakeRate: number
  steerRateBase: number
  steerSpeedFalloff: number
  gripTarmac: number
  gripDirt: number
  gripDrift: number
  gravity: number
  airYaw: number
  offtrackSpeedMul: number
  respawnTicks: number
  invulnTicks: number
  spinOutTicks: number
  driftMinSpeed: number
  driftTiers: [number, number, number]
  driftBoosts: [number, number, number]
  boostSpeedMul: number
  surgeSpeedMul: number
  kartRadius: number
  kartRestitution: number
  itemBoxRespawnTicks: number
  seekerSpeed: number
  boltSpeed: number
  entityTtl: number
}

export interface SimContext {
  track: Track
  query: TrackQuery
  tuning: Tuning
  characters: CharacterStats[]
  isLeader: boolean    // only a leader authority rolls items and advances rngCursor
}

export interface TrackProjection { s: number; lateral: number; distance: number }

export interface TrackQuery {
  sampleAt(s: number): TrackPoint
  tangentAt(s: number): Vec3
  project(p: Vec3): TrackProjection
  groundHeight(s: number, lateral: number): number
  surfaceAt(s: number, lateral: number): Surface
  isInBounds(s: number, lateral: number): boolean
  checkpointIndexAt(s: number): number
  totalLength(): number
}
