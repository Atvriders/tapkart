import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Items 10b-10d, gated over source text.
//
// There is no Android toolchain, emulator or device in this environment, and
// :app:testDebugUnitTest is plain JUnit with no Robolectric and no
// returnDefaultValues, so every android.view.Window call throws "not mocked".
// The Kotlin behaviour therefore cannot be executed anywhere in this project —
// what CAN be asserted is that the two window calls exist and say the right
// thing, which is enough to fail loudly if someone deletes them.
//
// apps/android/scripts/assert-manifest.mjs asserts the same manifest facts
// against the MERGED manifest in CI. That is the stronger gate and it is the
// one that catches a library merging an orientation lock back in; this one runs
// in a plain checkout with no Gradle build, so it is the gate that fires during
// development.

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

const MANIFEST = read('../app/src/main/AndroidManifest.xml')
const MAIN_ACTIVITY = read('../app/src/main/kotlin/io/github/atvriders/tapkart/MainActivity.kt')
const STYLES = read('../app/src/main/res/values/styles.xml')
const STYLES_V27 = read('../app/src/main/res/values-v27/styles.xml')

/** Attributes of the one <activity> element, read off the source manifest.
 *  Comments are stripped first: the block above the activity mentions
 *  screenOrientation by name, and a naive search would find it there forever. */
function activityAttrs(): Record<string, string> {
  const text = MANIFEST.replaceAll(/<!--[\s\S]*?-->/g, '')
  const open = text.indexOf('<activity')
  const close = text.indexOf('>', open)
  const body = text.slice(open, close)
  const attrs: Record<string, string> = {}
  for (const m of body.matchAll(/(android:[A-Za-z]+)="([^"]*)"/g)) attrs[m[1]] = m[2]
  return attrs
}

/** name -> value for every <item> of one <style>. */
function styleItems(xml: string, styleName: string): Map<string, string> {
  const open = xml.indexOf(`<style name="${styleName}"`)
  const items = new Map<string, string>()
  if (open < 0) return items
  const body = xml.slice(open, xml.indexOf('</style>', open))
  for (const m of body.matchAll(/<item name="([^"]+)"\s*>([^<]*)<\/item>/g)) items.set(m[1], m[2].trim())
  return items
}

function styleParent(xml: string, styleName: string): string | undefined {
  return new RegExp(`<style name="${styleName}"\\s+parent="([^"]+)"`).exec(xml)?.[1]
}

describe('AndroidManifest — R51, every viewport is a layout (item 10c)', () => {
  const attrs = activityAttrs()

  it('reads the activity element it is about to assert on', () => {
    // ANTI-VACUITY. Without this, a scanner that found no activity at all would
    // report an empty attribute map, and "declares no orientation lock" would
    // pass on a manifest with no activity in it.
    expect(attrs['android:name']).toBe('.MainActivity')
    expect(attrs['android:launchMode']).toBe('singleTask')
  })

  it('declares no orientation lock', () => {
    // The lock was already unenforceable where it mattered: targetSdk 36 means
    // Android 16 ignores screenOrientation on sw >= 600dp, so a tablet or an
    // unfolded foldable could boot portrait today and land on a permanent
    // rotate overlay above a canvas that never got resized.
    expect(attrs['android:screenOrientation']).toBeUndefined()
  })

  it('declares resizeableActivity explicitly', () => {
    // Already the platform default for targetSdk >= 24, declared anyway so the
    // intent is a thing an assertion can see. An assertion cannot fail on a
    // default that is simply absent from the file.
    expect(attrs['android:resizeableActivity']).toBe('true')
  })

  it('handles every configuration change a fold, a rotate or a bar toggle produces', () => {
    // Any one of these left undeclared destroys the activity, reloads the
    // WebView and drops the live race back to the title screen — no crash, no
    // log line, and it presents as a networking bug. density and fontScale are
    // the foldable cases: the inner and outer panels can report different
    // densities, so an unfold is a density change as well as a size change.
    const handled = (attrs['android:configChanges'] ?? '').split('|')
    for (const required of [
      'orientation',
      'screenSize',
      'smallestScreenSize',
      'screenLayout',
      'density',
      'fontScale',
      'uiMode',
    ]) {
      expect(handled).toContain(required)
    }
  })
})

describe('MainActivity — the immersive setup config cannot express (item 10b)', () => {
  it('still registers the NFC plugin before super.onCreate', () => {
    // ANTI-VACUITY, and a real invariant: Capacitor builds the bridge inside
    // super.onCreate, and a plugin registered after it is never seen.
    const register = MAIN_ACTIVITY.indexOf('registerPlugin(TapkartNfcPlugin::class.java)')
    const superCall = MAIN_ACTIVITY.indexOf('super.onCreate(savedInstanceState)')
    expect(register).toBeGreaterThan(-1)
    expect(superCall).toBeGreaterThan(register)
  })

  it('makes a swiped-in bar transient instead of permanent', () => {
    // Nothing in Capacitor sets systemBarsBehavior, so the effective policy is
    // BEHAVIOR_DEFAULT and the first edge swipe during a race brings the bars
    // back and leaves them back. That is precisely the reported symptom.
    expect(MAIN_ACTIVITY).toContain('systemBarsBehavior')
    expect(MAIN_ACTIVITY).toContain(
      'WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE',
    )
  })

  it('re-hides the bars whenever focus returns', () => {
    // SystemBars.handleOnConfigurationChanged re-applies only the bar STYLE,
    // never `hidden`, so nothing re-hides after a rotate, a fold or a resume.
    // Focus is the one edge that covers all three.
    expect(MAIN_ACTIVITY).toMatch(/override fun onWindowFocusChanged\(hasFocus: Boolean\)/)
    expect(MAIN_ACTIVITY).toMatch(/if \(hasFocus\)/)
    expect(MAIN_ACTIVITY).toContain('.hide(WindowInsetsCompat.Type.systemBars())')
  })
})

describe('values-v27 — the display cutout theme (item 10d)', () => {
  const base = styleItems(STYLES, 'AppTheme.NoActionBar')
  const v27 = styleItems(STYLES_V27, 'AppTheme.NoActionBar')

  it('reads both copies of the theme that is actually in force at runtime', () => {
    // ANTI-VACUITY: BridgeActivity calls setTheme(R.style.AppTheme_NoActionBar)
    // before setContentView, so this — not the launch theme named in the
    // manifest — is the theme the WebView is created under.
    expect(base.size).toBeGreaterThan(0)
    expect(v27.size).toBeGreaterThan(base.size)
  })

  it('asks for shortEdges on API 27+', () => {
    expect(v27.get('android:windowLayoutInDisplayCutoutMode')).toBe('shortEdges')
  })

  it('is a superset of the base theme, because a qualified style REPLACES it', () => {
    // Resource qualification is not a merge. Everything the base style declares
    // has to be repeated here or it silently vanishes on every device newer
    // than API 26 — which is every device.
    for (const [name, value] of base) expect(v27.get(name)).toBe(value)
    expect(styleParent(STYLES_V27, 'AppTheme.NoActionBar')).toBe(
      styleParent(STYLES, 'AppTheme.NoActionBar'),
    )
  })
})
