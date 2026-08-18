// ADAPTER. The only node:http in packages/server/src. Every routing decision is
// resolveRoute's; this file only translates the returned Route into I/O.
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import { SIGNAL_MAX_BYTES } from '@tapkart/net'
import type { ServerConfig } from '../env'
import type { RoomHub } from '../hub'
import { resolveRoute, safeJoin } from '../static'
import { readFileBytes } from './files'
import { wrapWsSocket } from './ws'

export interface HttpServerHandle {
  port(): number
  close(): Promise<void>
}

const TEXT = new TextEncoder()
const HEALTH_BODY = TEXT.encode('{"ok":true}\n')
const NOT_FOUND_BODY = TEXT.encode('not found\n')
const NOT_ALLOWED_BODY = TEXT.encode('method not allowed\n')
const UPGRADE_BODY = TEXT.encode('upgrade required\n')
const PLAIN = 'text/plain; charset=utf-8'
const HTML = 'text/html; charset=utf-8'

function send(
  req: IncomingMessage, res: ServerResponse, status: number, contentType: string, body: Uint8Array,
): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': String(body.byteLength) })
  if (req.method === 'HEAD') res.end()
  else res.end(body)
}

function sendFile(
  cfg: ServerConfig, req: IncomingMessage, res: ServerResponse, relPath: string, contentType: string,
): void {
  const full = safeJoin(cfg.staticRoot, relPath)
  const bytes = full === null ? null : readFileBytes(full)
  if (bytes === null) {
    // In particular, assetlinks.json remains a visible 404 until Plan 5
    // generates it. No redirect can be introduced at this layer.
    send(req, res, 404, PLAIN, NOT_FOUND_BODY)
    return
  }
  send(req, res, 200, contentType, bytes)
}

function pathnameOf(url: string): string {
  const query = url.indexOf('?')
  return query < 0 ? url : url.slice(0, query)
}

function serve(cfg: ServerConfig, req: IncomingMessage, res: ServerResponse): void {
  const route = resolveRoute(req.method ?? 'GET', pathnameOf(req.url ?? '/'))
  switch (route.kind) {
    case 'health':
      send(req, res, 200, 'application/json', HEALTH_BODY)
      return
    case 'websocket':
      send(req, res, 426, PLAIN, UPGRADE_BODY)
      return
    case 'methodNotAllowed':
      send(req, res, 405, PLAIN, NOT_ALLOWED_BODY)
      return
    case 'notFound':
      send(req, res, 404, PLAIN, NOT_FOUND_BODY)
      return
    case 'file':
      sendFile(cfg, req, res, route.relPath, route.contentType)
      return
    case 'wellKnown':
      sendFile(cfg, req, res, route.relPath, route.contentType)
      return
    case 'spa':
      sendFile(cfg, req, res, 'index.html', HTML)
      return
    default: {
      const unreachable: never = route
      return unreachable
    }
  }
}

function portOf(server: Server): number {
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

export function startHttpServer(
  cfg: ServerConfig, hub: RoomHub, nowMs: () => number,
): Promise<HttpServerHandle> {
  const server = createServer((req, res) => { serve(cfg, req, res) })
  // Signalling is the largest public WebSocket payload this protocol accepts;
  // checkpoints and every binary race frame are smaller. Enforce the same cap
  // in `ws` so an unauthenticated peer cannot make the adapter buffer an
  // arbitrarily large message before the pure decoders get a chance to reject
  // it.
  const wss = new WebSocketServer({ noServer: true, maxPayload: SIGNAL_MAX_BYTES })
  let closePromise: Promise<void> | null = null

  server.on('upgrade', (req, socket, head) => {
    // Upgrade routing uses the request's real method. An Upgrade header cannot
    // turn POST /ws into the GET-only WebSocket route.
    if (resolveRoute(req.method ?? 'GET', pathnameOf(req.url ?? '/')).kind !== 'websocket') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (raw) => { hub.attach(wrapWsSocket(raw), nowMs()) })
  })

  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise
    closePromise = (async (): Promise<void> => {
      for (const client of wss.clients) client.terminate()
      await Promise.all([
        new Promise<void>((done) => { wss.close(() => { done() }) }),
        new Promise<void>((done) => {
          if (!server.listening) {
            done()
            return
          }
          server.close(() => { done() })
        }),
      ])
    })()
    return closePromise
  }

  return new Promise<HttpServerHandle>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      // A failed bind owns no runnable handle, so release both host objects here
      // before handing the rejection back to the composition root.
      for (const client of wss.clients) client.terminate()
      wss.close()
      if (server.listening) server.close()
      reject(error)
    }

    server.once('error', onListenError)
    server.listen(cfg.port, cfg.bindHost, () => {
      server.off('error', onListenError)
      resolve({ port: () => portOf(server), close })
    })
  })
}
