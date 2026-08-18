// ADAPTER -- the composition root. It wires the five adapters into RoomHub and
// starts one scheduler only after the HTTP server has bound successfully.
import { pathToFileURL } from 'node:url'
import { parseConfig } from './env'
import { RoomRegistry } from './registry'
import { RoomHub } from './hub'
import { defaultContentProvider } from './content'
import { makeRateLimiter } from './ratelimit'
import type { LogEvent, LogSink } from './log'
import { formatLogEvent } from './log'
import { POLL_INTERVAL_MS, makeIntervalScheduler, realNowMs } from './runtime/clock'
import { nodeRandomSource } from './runtime/random'
import type { HttpServerHandle } from './runtime/http'
import { startHttpServer } from './runtime/http'

/** One formatted line per event. Stream I/O belongs at the composition root. */
const stdoutLogSink: LogSink = {
  write(ev: LogEvent, nowMs: number): void {
    process.stdout.write(formatLogEvent(ev, nowMs) + '\n')
  },
}

export async function main(
  env: Readonly<Record<string, string | undefined>>,
): Promise<HttpServerHandle> {
  const config = parseConfig(env)
  const hub = new RoomHub({
    config,
    registry: new RoomRegistry({
      maxRooms: config.maxRooms,
      maxPeersPerRoom: config.maxPeersPerRoom,
      roomIdleMs: config.roomIdleMs,
      rand: nodeRandomSource,
    }),
    content: defaultContentProvider,
    rand: nodeRandomSource,
    log: stdoutLogSink,
    // F-P4-34: keyed by room code, never by anything derived from an address.
    failedJoins: makeRateLimiter(config.joinRateLimit),
  })
  const scheduler = makeIntervalScheduler()
  let server: HttpServerHandle | null = null

  try {
    server = await startHttpServer(config, hub, realNowMs)
    scheduler.start(POLL_INTERVAL_MS, (nowMs) => { hub.poll(nowMs) })
  } catch (error) {
    scheduler.stop()
    hub.close()
    if (server !== null) {
      try {
        await server.close()
      } catch {
        // Preserve the startup error; teardown is best-effort on this path.
      }
    }
    throw error
  }

  const running = server
  let closePromise: Promise<void> | null = null
  return {
    port: (): number => running.port(),
    close: (): Promise<void> => {
      if (closePromise !== null) return closePromise
      closePromise = (async (): Promise<void> => {
        scheduler.stop()
        hub.close()
        await running.close()
      })()
      return closePromise
    },
  }
}

function describeFatal(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  return String(error)
}

// Importing this module is inert; executing the bundle starts it. Every startup
// rejection is made visible and gives the process a failing exit status.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main(process.env).then((handle) => {
    process.stdout.write('tapkart server listening on port ' + String(handle.port()) + '\n')
  }).catch((error: unknown) => {
    process.stderr.write('tapkart server failed: ' + describeFatal(error) + '\n')
    process.exitCode = 1
  })
}
