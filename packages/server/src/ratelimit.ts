// PURE. A fixed-window counter keyed by the caller's canonical room code.
import type { RateLimitConfig } from './env'

interface Window {
  start: number
  count: number
}

const MAX_TRACKED_KEYS = 4096

export interface RateLimiter {
  allowed(key: string, nowMs: number): boolean
  note(key: string, nowMs: number): void
  reset(): void
}

export function makeRateLimiter(cfg: RateLimitConfig): RateLimiter {
  const windows = new Map<string, Window>()
  const expired = (window: Window, nowMs: number): boolean =>
    nowMs - window.start >= cfg.windowMs

  return {
    allowed(key: string, nowMs: number): boolean {
      const window = windows.get(key)
      if (window === undefined || expired(window, nowMs)) return true
      return window.count < cfg.max
    },

    note(key: string, nowMs: number): void {
      const window = windows.get(key)
      if (window !== undefined && !expired(window, nowMs)) {
        window.count++
        return
      }

      if (window === undefined && windows.size >= MAX_TRACKED_KEYS) {
        for (const [trackedKey, entry] of windows) {
          if (expired(entry, nowMs)) windows.delete(trackedKey)
        }
        if (windows.size >= MAX_TRACKED_KEYS) windows.clear()
      }
      windows.set(key, { start: nowMs, count: 1 })
    },

    reset(): void {
      windows.clear()
    },
  }
}
