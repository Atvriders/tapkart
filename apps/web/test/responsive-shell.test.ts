import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The shell's CSS is inline in index.html on purpose (extracting it to a .css file
// would add Vite-manifest and service-worker-precache surface for no test benefit),
// which means the ONLY gate available to a node-environment suite is a text/parse
// assertion over the document. There is no jsdom here and there must not be one, so
// this file proves the declarations exist and, just as importantly, that the specific
// declarations that used to be here — and that a future edit would naturally
// reintroduce — are gone. The computed-style half of the gate (that the type actually
// resizes between viewports) lives in e2e/responsive.spec.ts; neither half can fail
// correctly on its own, because text alone passes on an unused media query and
// computed style alone cannot see a bare `100vh` that happens to be right today.
const HTML = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')

/** Body of the first rule whose selector is exactly `selector`. Brace-matched, so a
 *  rule nested inside an @media block is returned whole rather than truncated. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Anchored to the start of a line, because every selector in this stylesheet
  // starts one: without that, `.tk-controls` would match inside
  // `#tk-root > .tk-controls` and return the wrong rule's body.
  const head = new RegExp(`(^|\\n)[ \\t]*${escaped}\\s*\\{`, 'm').exec(HTML)
  if (head === null) throw new Error(`no rule for selector ${selector}`)
  const open = HTML.indexOf('{', head.index + head[0].length - 1)
  let depth = 0
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++
    else if (HTML[i] === '}') {
      depth--
      if (depth === 0) return HTML.slice(open + 1, i)
    }
  }
  throw new Error(`unterminated rule for selector ${selector}`)
}

// A bare viewport-height unit. Banned outright: the shell is `position: fixed;
// inset: 0` over a `height: 100%` document, which already tracks the layout viewport,
// and `vh` on mobile measures the LARGEST viewport, so a retracted toolbar pushes the
// bottom of any vh-sized box off screen. `dvh`/`dvmin` deliberately do not match.
const BARE_VH = /\d+vh\b/

describe('index.html responsive CSS — the gate (§5)', () => {
  it('can see the document it is asserting about', () => {
    // ANTI-VACUITY. Every assertion below is a substring or regex test against HTML;
    // if the read silently produced the wrong file (or an empty one) all of the
    // "contains" checks would fail loudly but all of the "does not contain" checks
    // would pass forever. This pins that the file is the shell document, that the
    // extractor really extracts, and that BARE_VH is capable of matching.
    expect(HTML).toContain('<style>')
    expect(HTML).toContain('id="tk-canvas"')
    expect(rule('.tk-controls')).toContain('z-index: 3')
    expect(BARE_VH.test('font-size: 22vh;')).toBe(true)
    expect(BARE_VH.test('height: 100vh')).toBe(true)
    expect(() => rule('.tk-no-such-class')).toThrow()
  })

  it('carries the four responsive mechanisms at all', () => {
    expect(HTML).toContain('@media')
    expect(HTML).toContain('clamp(')
    expect(HTML).toContain('env(safe-area-inset-')
    expect(HTML).toContain('--tk-ui-scale')
  })

  it('never uses a bare viewport-height unit anywhere', () => {
    expect(HTML).not.toMatch(BARE_VH)
  })
})

describe('.tk-screen — the menu screens scroll instead of clipping', () => {
  const screen = rule('.tk-screen')

  it('scrolls its own overflow and does not chain to the page', () => {
    // Without this, a lobby taller than the viewport (844x390 landscape phone) is
    // clipped symmetrically by `justify-content: center` and START RACE becomes
    // both invisible and unreachable.
    expect(screen).toMatch(/overflow-y:\s*auto/)
    expect(screen).toMatch(/overscroll-behavior:\s*contain/)
  })

  it('starts at the top, and only centres once there is height to centre in', () => {
    expect(screen).toMatch(/justify-content:\s*flex-start/)
    expect(screen).not.toMatch(/justify-content:\s*center/)
    expect(HTML).toMatch(
      /@media\s*\(min-height:\s*560px\)\s*\{\s*\.tk-screen\s*\{[^}]*justify-content:\s*center/,
    )
  })

  it('re-grants vertical panning, which html/body took away', () => {
    // html/body are `touch-action: none` so a steering thumb is never stolen. That
    // intersects down through descendants, so the overflow above would be
    // finger-dead on a phone without this.
    expect(screen).toMatch(/touch-action:\s*pan-y/)
  })

  it('pads to the safe area on all four edges, never a bare 24px', () => {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(screen).toContain(`max(24px, env(safe-area-inset-${side}))`)
    }
    expect(screen).not.toMatch(/padding:\s*24px/)
  })
})

describe('fluid type and hit targets', () => {
  it('sizes the heading with clamp(), not a fixed px', () => {
    // The regression this catches is literal: `font-size: 40px` overflowed a
    // 360px-wide portrait phone and wasted a tablet.
    const h1 = rule('.tk-screen h1')
    expect(h1).toContain('font-size: clamp(22px, 6vmin, 44px)')
    expect(h1).not.toMatch(/font-size:\s*\d+px/)
  })

  it('scales menu buttons by the pure layout metric, with a 44px floor', () => {
    const btn = rule('.tk-btn')
    expect(btn).toContain('min-height: clamp(44px, calc(46px * var(--tk-ui-scale, 1)), 64px)')
    expect(btn).toContain('min-width: clamp(96px, 26vmin, 150px)')
    expect(btn).not.toMatch(/min-height:\s*\d+px/)
    expect(btn).not.toMatch(/min-width:\s*\d+px/)
  })

  it('sizes the results list fluidly', () => {
    expect(rule('.tk-screen ol')).toContain('font-size: clamp(15px, 3.2vmin, 20px)')
  })

  it('gives the countdown a dynamic-viewport size with a static fallback', () => {
    // Order matters: the fallback must come FIRST so a supporting engine overrides it.
    const countdown = rule('.tk-hud .tk-countdown')
    expect(countdown.indexOf('font-size: 22vmin')).toBeGreaterThanOrEqual(0)
    expect(countdown.indexOf('font-size: 22dvmin')).toBeGreaterThan(
      countdown.indexOf('font-size: 22vmin'),
    )
  })
})

describe('safe-area insets reach everything pinned to an edge', () => {
  it('lifts the HUD out from under the status bar and any cutout', () => {
    const hud = rule('.tk-hud')
    expect(hud).toContain('top: max(16px, env(safe-area-inset-top))')
    expect(hud).toContain('left: max(16px, env(safe-area-inset-left))')
    expect(hud).not.toMatch(/(^|[;{\s])(top|left):\s*\d+px/)
  })

  it('insets the expanded settings panel on all three pinned edges', () => {
    const panel = rule('.tk-settings[data-expanded="true"]')
    for (const side of ['top', 'left', 'right']) {
      expect(panel).toContain(`${side}: max(12px, env(safe-area-inset-${side}))`)
    }
    expect(panel).not.toMatch(/(^|[;{\s])(top|left|right):\s*\d+px/)
  })

  it('defines the probe the shell measures, reading env() and the APK variable', () => {
    // The var() half is what works inside the APK, where Capacitor's SystemBars
    // plugin sets --safe-area-inset-* on the root element; env() is what works in a
    // browser. Dropping either side silently returns 0 on one of the two platforms,
    // which is a class of bug no headless test could otherwise see.
    const probe = rule('.tk-insets')
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(probe).toMatch(
        new RegExp(
          `padding-${side}:\\s+max\\(env\\(safe-area-inset-${side}, 0px\\),` +
            `\\s+var\\(--safe-area-inset-${side}, 0px\\)\\)`,
        ),
      )
    }
    expect(probe).toMatch(/visibility:\s*hidden/)
    expect(probe).toMatch(/pointer-events:\s*none/)
  })
})

describe('.tk-blocked replaces the retired rotate prompt', () => {
  it('defines the blocked overlay, centred and padded', () => {
    const blocked = rule('.tk-blocked')
    expect(blocked).toMatch(/position:\s*absolute/)
    expect(blocked).toMatch(/inset:\s*0/)
    expect(blocked).toMatch(/z-index:\s*20/)
    expect(blocked).toMatch(/text-align:\s*center/)
    expect(blocked).toMatch(/padding:\s*24px/)
  })

  it('leaves no .tk-rotate styling behind', () => {
    // A stale rule here is not cosmetic: it is the thing that would let someone
    // reintroduce the landscape-only refusal without noticing the CSS still fits it.
    expect(HTML).not.toContain('tk-rotate')
  })
})

describe('the invite QR cannot be cropped by its panel', () => {
  it('bounds any canvas inside a screen to the panel width', () => {
    const qr = rule('.tk-screen canvas')
    expect(qr).toMatch(/max-width:\s*100%/)
    expect(qr).toMatch(/height:\s*auto/)
  })
})
