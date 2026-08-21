import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.github.atvriders.tapkart',
  appName: 'Tapkart',
  webDir: '../web/dist',

  // The generated native project is deliberately flat inside this workspace.
  android: { path: '.' },

  plugins: {
    // Requirement 3 (no status bar), and it costs no new dependency:
    // @capacitor/android 8.5 registers com.getcapacitor.plugin.SystemBars from
    // Bridge.java unconditionally, and @capacitor/cli already declares these
    // keys. Adding @capacitor/status-bar would install a second owner of the
    // same window flags.
    //
    // `hidden` MUST be expressed here rather than only in Kotlin. Leaving the
    // key out does NOT leave the bars alone: initSystemBars() reads it with a
    // default of false and then actively calls setHidden(false, "") through
    // Bridge.executeOnMainThread — a posted Runnable, so it lands AFTER
    // MainActivity.onCreate has returned. A native hide() written in onCreate
    // is silently reverted a frame later, and the bug reads as intermittent.
    // Native code (MainActivity) therefore handles only what this config
    // cannot express: swipe behaviour and re-hiding on focus.
    //
    // Note `hidden: true` with no `bar` argument hides the navigation bar as
    // well (setHidden -> WindowInsetsCompat.Type.systemBars()). If only the
    // status bar should go, this becomes a JS SystemBars.hide({ bar:
    // 'StatusBar' }) call instead.
    //
    // style DARK means dark bars / light glyphs, which is what a transiently
    // swiped-in bar should look like over the race.
    //
    // insetsHandling 'css' is also the plugin default, pinned because the web
    // layout now depends on it: it injects --safe-area-inset-* onto
    // documentElement, and that is the reliable safe-area source inside the
    // WebView. env(safe-area-inset-*) alone is not dependable here.
    SystemBars: { hidden: true, style: 'DARK', insetsHandling: 'css' },
  },
}

export default config
