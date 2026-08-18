// Pure build tooling. The public surface is fixed at the two functions below.

/** Returns every emitted file and explicit extra as a sorted absolute path. */
export function buildPrecacheList(viteManifest, extras) {
  const paths = new Set()
  const add = (path) => {
    if (typeof path !== 'string' || path.length === 0) return
    paths.add(path.startsWith('/') ? path : `/${path}`)
  }

  for (const [key, record] of Object.entries(viteManifest)) {
    if (typeof record.file !== 'string' || record.file.length === 0) {
      throw new Error(`buildPrecacheList: manifest entry '${key}' has no 'file'`)
    }
    add(record.file)
    for (const css of record.css ?? []) add(css)
    for (const asset of record.assets ?? []) add(asset)
  }
  for (const extra of extras) add(extra)

  return [...paths].sort()
}

/** FNV-1a over ordered, separator-delimited version seeds. Callers normally
 * pass the path list; build-sw privately appends each file's content digest so
 * unhashed shell/manifest/icon changes move the cache name too.
 */
export function precacheVersion(list) {
  let hash = 0x811c9dc5
  const joined = list.join('\n')
  for (let i = 0; i < joined.length; i++) {
    hash ^= joined.charCodeAt(i) & 0xff
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
