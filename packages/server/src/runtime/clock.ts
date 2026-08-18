// ADAPTER. The only Date.now() and the only setInterval in packages/server.
// Nothing here decides anything: it reads a clock and drives a callback.

export function realNowMs(): number {
  return Date.now()
}

export interface Scheduler {
  start(intervalMs: number, cb: (nowMs: number) => void): void
  stop(): void
}

/**
 * ONE scheduler for the whole process, not one timer per room: the
 * rooms-per-process budget is spent on step(), and N timers would spend it on
 * the event loop instead.
 */
export function makeIntervalScheduler(): Scheduler {
  let handle: ReturnType<typeof setInterval> | null = null
  return {
    start(intervalMs: number, cb: (nowMs: number) => void): void {
      handle = setInterval(() => { cb(realNowMs()) }, intervalMs)
      // The listening socket keeps the process alive, not the heartbeat. Without
      // this a closed server still holds the event loop open.
      handle.unref()
    },
    stop(): void {
      if (handle === null) return
      clearInterval(handle)
      handle = null
    },
  }
}

/**
 * 125 Hz. The hub polls faster than the sim ticks on purpose: the accumulator
 * turns a jittery 8 ms timer into exact 60 Hz steps.
 */
export const POLL_INTERVAL_MS = 8
