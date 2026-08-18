// PURE. Total over any method and any pathname, and it imports no `node:path`:
// §5.14 confines that to src/runtime/, and the joining rule is four lines over a
// POSIX separator, which is what the container serves from.
import { LOBBY_PATH_PREFIX } from '@tapkart/protocol'

export const WS_PATH = '/ws'
export const HEALTH_PATH = '/healthz'
export const WELL_KNOWN_PREFIX = '/.well-known/'
export const ASSETLINKS_PATH = '/.well-known/assetlinks.json'

/**
 * The whole routing table.
 *
 * There is NO redirect member, and that is the mechanism rather than an
 * omission (C-2). Spec §2 and §9 both require /.well-known/assetlinks.json to be
 * served with no redirects, and on Android 12+ a failed App Links verification
 * is silent: no chooser, no error, no log -- the link just opens in a browser.
 * A table that cannot express a redirect cannot acquire one by accident later.
 */
export type Route =
  | { kind: 'file'; relPath: string; contentType: string }
  | { kind: 'spa' }                                          // serve index.html, 200
  | { kind: 'wellKnown'; relPath: string; contentType: string }
  | { kind: 'health' }
  | { kind: 'websocket' }
  | { kind: 'methodNotAllowed' }
  | { kind: 'notFound' }

export function resolveRoute(method: string, pathname: string): Route {
  const verb = method.toUpperCase()
  if (verb !== 'GET' && verb !== 'HEAD') return { kind: 'methodNotAllowed' }

  // Not a path at all. These never reach the filesystem.
  if (!pathname.startsWith('/')) return { kind: 'notFound' }
  if (pathname.includes('\u0000') || pathname.includes('\\')) return { kind: 'notFound' }

  if (pathname === WS_PATH) return { kind: 'websocket' }
  if (pathname === HEALTH_PATH) return { kind: 'health' }

  // Checked BEFORE the SPA catch-all, so no future "serve everything as the
  // SPA" rule can swallow it, and with NO trailing-slash normalisation: a
  // normaliser here is a redirect wearing a different hat.
  if (pathname.startsWith(WELL_KNOWN_PREFIX)) {
    const relPath = pathname.slice(1)
    return { kind: 'wellKnown', relPath, contentType: contentTypeOf(relPath) }
  }

  // `/r/ABCDE` is the invite path (C-1), and it is the SPA: the room code is the
  // client's to read. LOBBY_PATH_PREFIX is imported, never re-declared -- the
  // same string is compiled into an APK's autoVerify pathPrefix.
  if (pathname === '/' || pathname.startsWith(LOBBY_PATH_PREFIX)) return { kind: 'spa' }

  const relPath = pathname.slice(1)
  const lastSlash = relPath.lastIndexOf('/')
  const lastSegment = relPath.slice(lastSlash + 1)
  if (lastSegment.includes('.')) {
    return { kind: 'file', relPath, contentType: contentTypeOf(relPath) }
  }
  // Everything else is a client-side route.
  return { kind: 'spa' }
}

const CONTENT_TYPES = new Map<string, string>([
  ['html', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['json', 'application/json'],
  ['map', 'application/json'],
  ['webmanifest', 'application/manifest+json'],
  ['wasm', 'application/wasm'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['ico', 'image/x-icon'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['ttf', 'font/ttf'],
  ['mp3', 'audio/mpeg'],
  ['ogg', 'audio/ogg'],
  ['wav', 'audio/wav'],
  ['txt', 'text/plain; charset=utf-8'],
  ['glb', 'model/gltf-binary'],
  ['gltf', 'model/gltf+json'],
])

export function contentTypeOf(relPath: string): string {
  // MIME metadata does not decide filesystem identity. A terminal separator is
  // kept in Route.relPath/safeJoin, but the asset immediately before it still
  // has the same declared media type.
  const lookup = relPath.replace(/\/+$/, '')
  const dot = lookup.lastIndexOf('.')
  const slash = lookup.lastIndexOf('/')
  if (dot < 0 || dot < slash || dot === lookup.length - 1) return 'application/octet-stream'
  const found = CONTENT_TYPES.get(lookup.slice(dot + 1).toLowerCase())
  return found === undefined ? 'application/octet-stream' : found
}

/**
 * Joins and normalises, returning null on any traversal outside `root` -- '..',
 * absolute paths, encoded separators, NUL, backslashes. The one function
 * standing between a public URL and the filesystem.
 *
 * It decodes percent-escapes EXACTLY ONCE. Without decoding, a legitimate asset
 * with a space in its name would never be found; decoding twice would let
 * `%252e%252e` become a traversal on the second pass.
 */
export function safeJoin(root: string, relPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(relPath)
  } catch {
    return null            // a malformed escape reaches us from a public URL
  }

  if (decoded.length === 0) return null
  if (decoded.includes('\u0000')) return null
  if (decoded.includes('\\')) return null
  if (decoded.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(decoded)) return null       // a Windows drive is absolute too

  // Routing deliberately distinguishes /.well-known/file from
  // /.well-known/file/. Preserve that distinction through the filesystem seam
  // so the latter cannot silently alias the former instead of returning 404.
  const trailingSlash = decoded.endsWith('/')

  const parts: string[] = []
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    parts.push(segment)
  }
  if (parts.length === 0) return null

  const base = root.endsWith('/') ? root.slice(0, -1) : root
  return base + '/' + parts.join('/') + (trailingSlash ? '/' : '')
}
