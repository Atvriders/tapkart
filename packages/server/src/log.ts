// PURE. Events remain typed until a runtime sink decides how to emit them.
import type { JoinResult, ResyncReason } from '@tapkart/protocol'

export type LogEvent =
  | { kind: 'roomCreated'; code: string }
  | { kind: 'roomExpired'; code: string; ageMs: number }
  | { kind: 'peerJoined'; code: string; playerId: number; relay: boolean }
  | { kind: 'peerLeft'; code: string; playerId: number }
  | { kind: 'peerReclaimed'; code: string; playerId: number }
  | { kind: 'raceStarted'; code: string; seed: number; trackId: string }
  | { kind: 'promotion'; code: string; tick: number; eventSeq: number }
  | { kind: 'checkpointSent'; code: string; playerId: number; reason: ResyncReason }
  | { kind: 'relayFirst'; code: string; failures: number }
  | { kind: 'rejected'; code: string; result: JoinResult }
  | { kind: 'badFrame'; code: string; peerId: string; why: string }

export interface LogSink {
  write(ev: LogEvent, nowMs: number): void
}

export const nullLogSink: LogSink = {
  write(): void {
    // Intentionally empty.
  },
}

export function makeMemoryLogSink(): LogSink & { events(): readonly LogEvent[] } {
  const events: LogEvent[] = []
  return {
    write(ev: LogEvent): void {
      events.push(ev)
    },
    events(): readonly LogEvent[] {
      return events.slice()
    },
  }
}

function fieldsOf(ev: LogEvent): string {
  switch (ev.kind) {
    case 'roomCreated':
      return 'code=' + ev.code
    case 'roomExpired':
      return 'code=' + ev.code + ' ageMs=' + String(ev.ageMs)
    case 'peerJoined':
      return 'code=' + ev.code + ' playerId=' + String(ev.playerId) + ' relay=' + String(ev.relay)
    case 'peerLeft':
      return 'code=' + ev.code + ' playerId=' + String(ev.playerId)
    case 'peerReclaimed':
      return 'code=' + ev.code + ' playerId=' + String(ev.playerId)
    case 'raceStarted':
      return 'code=' + ev.code + ' seed=' + String(ev.seed) + ' trackId=' + ev.trackId
    case 'promotion':
      return 'code=' + ev.code + ' tick=' + String(ev.tick) + ' eventSeq=' + String(ev.eventSeq)
    case 'checkpointSent':
      return 'code=' + ev.code + ' playerId=' + String(ev.playerId) + ' reason=' + ev.reason
    case 'relayFirst':
      return 'code=' + ev.code + ' failures=' + String(ev.failures)
    case 'rejected':
      return 'code=' + ev.code + ' result=' + ev.result
    case 'badFrame':
      return 'code=' + ev.code + ' peerId=' + ev.peerId + ' why=' + ev.why.replace(/\s+/g, '_')
    default: {
      const unreachable: never = ev
      return unreachable
    }
  }
}

export function formatLogEvent(ev: LogEvent, nowMs: number): string {
  return String(nowMs) + ' ' + ev.kind + ' ' + fieldsOf(ev)
}
