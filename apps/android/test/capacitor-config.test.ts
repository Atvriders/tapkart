import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import config from '../capacitor.config'

// Item 10a. `capacitor.config.ts` is the committed source of truth: `cap sync`
// copies it verbatim into the gitignored app/src/main/assets/capacitor.config.json,
// so nothing downstream of the sync can be asserted on in a clean checkout.
//
// This file imports the config rather than reading it as text. Its only import
// is `import type`, which verbatimModuleSyntax erases, so it loads cleanly under
// vitest's environment:'node' with no bridge and no DOM.

const systemBars = config.plugins?.SystemBars

describe('capacitor.config — SystemBars carries requirement 3 (item 10a)', () => {
  it('declares the plugin under the name @capacitor/android actually registers', () => {
    // Bridge.java registers com.getcapacitor.plugin.SystemBars. A config block
    // spelled `StatusBar` (the pre-8 name, and the name muscle memory reaches
    // for) is not an error anywhere — the plugin simply never sees it and the
    // bars stay visible with nothing to grep for.
    expect(systemBars).toBeDefined()
  })

  it('hides the bars from config, because native code cannot win that race', () => {
    // With the key absent, initSystemBars() defaults it to false and posts
    // setHidden(false, "") to the main thread — after onCreate has returned. A
    // hide written only in Kotlin is reverted a frame later, intermittently.
    expect(systemBars?.hidden).toBe(true)
  })

  it('leaves the CSS safe-area injection on', () => {
    // 'css' injects --safe-area-inset-* onto documentElement, which is what the
    // web layout's inset probe reads inside the APK. 'disable' would silently
    // put the HUD and the button cluster back under the cutout.
    expect(systemBars?.insetsHandling).toBe('css')
  })

  it('asks for light glyphs on the bars a transient swipe reveals', () => {
    expect(systemBars?.style).toBe('DARK')
  })
})

describe('capacitor.config — no second owner of the window flags', () => {
  const pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } =
    JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }

  it('has @capacitor/android, which is where the SystemBars plugin lives', () => {
    // ANTI-VACUITY for the assertion below: proves this object really is the
    // dependency map and not an empty one, in which case "absent" is trivial.
    expect(deps['@capacitor/android']).toBeDefined()
  })

  it('does not add @capacitor/status-bar', () => {
    // The standalone plugin and the core SystemBars plugin both drive
    // WindowInsetsControllerCompat on the same window. Two owners means the
    // last writer wins, and which one that is depends on plugin registration
    // order — i.e. the bars come back on some devices and not others.
    expect(deps['@capacitor/status-bar']).toBeUndefined()
  })
})
