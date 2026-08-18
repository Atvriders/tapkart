import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// §8.2: `controls/source.ts` is the one controls module allowed to own DOM APIs.
// Most of this suite reads it as text; controls-source.test imports its event-target
// boundary directly so the calibration snapshot seam has behavioral coverage.
const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const CONTROLS = `${SRC}controls/`

const DOM_PATTERNS: [string, RegExp][] = [
  ['addEventListener', /\baddEventListener\b/],
  ['removeEventListener', /\bremoveEventListener\b/],
  ['window', /\bwindow\b/],
  ['document', /\bdocument\b/],
  ['navigator', /\bnavigator\b/],
  ['localStorage', /\blocalStorage\b/],
  ['DeviceOrientationEvent', /\bDeviceOrientationEvent\b/],
  ['PointerEvent', /\bPointerEvent\b/],
]

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('§8.2 DOM seam', () => {
  it('source.ts exists and is the file that owns the DOM', () => {
    // ANTI-VACUITY: this asserts the patterns below can actually match something.
    // Without it, a typo'd regex would make every "is DOM-free" assertion pass on
    // every file in the repository, forever.
    const src = read(`${CONTROLS}source.ts`)
    expect(src).toMatch(/\baddEventListener\b/)
    expect(src).toMatch(/\bremoveEventListener\b/)
    expect(src).toMatch(/deviceorientation/)
    expect(src).toMatch(/\bpointercancel\b/)
  })

  it('no other controls module names a DOM API', () => {
    // CATCHES the failure mode Q30 describes: a "pure" module quietly acquiring a
    // browser dependency, which surfaces later as an unrelated headless suite
    // breaking and gets "fixed" by switching the environment to jsdom.
    const files = readdirSync(CONTROLS).filter((f) => f.endsWith('.ts') && f !== 'source.ts')
    expect(files.length).toBeGreaterThanOrEqual(8)
    for (const f of files) {
      const text = read(`${CONTROLS}${f}`)
      for (const [name, re] of DOM_PATTERNS) {
        expect(re.test(text), `${f} must not name ${name}`).toBe(false)
      }
    }
  })

  it('settings.ts never names localStorage', () => {
    // Contract §5.7: the store is INJECTED. A direct localStorage read here would
    // make loadSettings untestable headlessly and would throw in a Safari private
    // window, on startup, before the first frame.
    for (const f of ['settings.ts']) {
      const text = read(`${SRC}${f}`)
      for (const [name, re] of DOM_PATTERNS) {
        expect(re.test(text), `${f} must not name ${name}`).toBe(false)
      }
    }
  })

  it('the controls entry point does not reach the DOM adapter', () => {
    // CATCHES `makeControlAdapter` growing a convenience that attaches listeners:
    // controls/index.ts IS re-exported by the package barrel (§5.15), so an import
    // of './source' there would drag the DOM into every headless test transitively.
    const index = read(`${CONTROLS}index.ts`)
    expect(index.includes('./source')).toBe(false)
  })
})
