import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The shipped manifest and the build-time gate that guards it, read as bytes. Nothing here
// asserted any field of this file before, so its two load-bearing values could be reverted
// with zero signal — and a stale manifest then survives in the service-worker precache,
// where it outlives the deploy that fixed it.
const MANIFEST_SOURCE = readFileSync(
  fileURLToPath(new URL('../public/manifest.webmanifest', import.meta.url)),
  'utf8',
)
const BUILD_SW_SOURCE = readFileSync(
  fileURLToPath(new URL('../tools/build-sw.mjs', import.meta.url)),
  'utf8',
)
const manifest = JSON.parse(MANIFEST_SOURCE) as Record<string, unknown>

// Every `orientation` value in the Web App Manifest spec that pins the installed app to one
// axis. 'natural' belongs here: it locks too, just to whichever axis the device calls
// natural, which on a tablet is usually portrait and on a phone landscape.
const LOCKED_ORIENTATIONS = [
  'natural',
  'landscape',
  'landscape-primary',
  'landscape-secondary',
  'portrait',
  'portrait-primary',
  'portrait-secondary',
]

const DECLARATION = 'function assertManifestContract(webManifest) {'
const CALL_SITE = /^assertManifestContract\(webManifest\)$/m

/**
 * Slices `assertManifestContract` out of build-sw.mjs and evaluates it. The build script
 * cannot be imported — it runs a Vite build at module scope — so the alternative would be a
 * regex over its text, and a regex still passes when the comparison is inverted or the
 * operator flipped. Executing the real declaration means these tests fail for the same
 * reason `npm run build -w @tapkart/web` would.
 */
function loadManifestContract(): (m: unknown) => void {
  const from = BUILD_SW_SOURCE.indexOf(DECLARATION)
  expect(from, `build-sw.mjs no longer declares: ${DECLARATION}`).toBeGreaterThan(-1)
  const to = BUILD_SW_SOURCE.indexOf('\n}\n', from)
  expect(to, 'assertManifestContract has no top-level closing brace').toBeGreaterThan(from)
  const declaration = BUILD_SW_SOURCE.slice(from, to + 2)
  return new Function(`${declaration}\nreturn assertManifestContract`)() as (m: unknown) => void
}

const assertManifestContract = loadManifestContract()

// A manifest the contract must accept, written out rather than spread from the real one, so
// each rejection case below isolates the single field it mutates instead of tripping over
// whatever else happens to be wrong in the shipped file.
const VALID = { orientation: 'any', display: 'fullscreen' }

describe('public/manifest.webmanifest', () => {
  it('locks no orientation, so an installed tablet or foldable can rotate (D3/R51)', () => {
    expect(manifest.orientation).toBe('any')
    expect(LOCKED_ORIENTATIONS).not.toContain(manifest.orientation)
  })

  it('keeps display: fullscreen, the only chrome-free path once installed', () => {
    // Requirement 4 for the installed case is this field and nothing else: 'standalone'
    // still leaves the platform status bar sitting over the canvas, and the Fullscreen API
    // is unavailable inside the APK (Capacitor cancels onShowCustomView on the same tick).
    expect(manifest.display).toBe('fullscreen')
    expect(manifest.display_override).toEqual(['fullscreen', 'standalone'])
  })
})

describe('build-sw.mjs manifest contract', () => {
  it('is actually invoked by the build, not merely declared', () => {
    // ANTI-VACUITY: without this, every assertion below would keep passing against a
    // function the build had stopped calling, and the gate would enforce nothing.
    expect(BUILD_SW_SOURCE).toMatch(CALL_SITE)
    expect(typeof assertManifestContract).toBe('function')
    expect(CALL_SITE.test('assertManifestContract(webManifest)')).toBe(true)
  })

  it('accepts the manifest that ships', () => {
    // The build reads dist/manifest.webmanifest, which is this file copied verbatim, so a
    // throw here is a `npm run build` failure — which is Playwright's webServer command, so
    // it surfaces as the whole e2e suite timing out after 300s with an opaque message.
    expect(() => assertManifestContract(manifest)).not.toThrow()
  })

  it('rejects a regression to any locked orientation', () => {
    for (const orientation of LOCKED_ORIENTATIONS) {
      expect(() => assertManifestContract({ ...VALID, orientation }), orientation).toThrow(
        /orientation/,
      )
    }
    expect(() => assertManifestContract({ ...VALID, orientation: undefined })).toThrow(
      /orientation/,
    )
  })

  it('rejects a display that is not fullscreen', () => {
    for (const display of ['standalone', 'minimal-ui', 'browser', undefined]) {
      expect(() => assertManifestContract({ ...VALID, display }), String(display)).toThrow(
        /display/,
      )
    }
  })
})
