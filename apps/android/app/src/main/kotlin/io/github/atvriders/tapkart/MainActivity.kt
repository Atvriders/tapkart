package io.github.atvriders.tapkart

import android.os.Bundle
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.getcapacitor.BridgeActivity

/** ADAPTER. Registers the local plugin before Capacitor builds the bridge, and
 *  owns the two parts of the immersive mode that capacitor.config.ts cannot
 *  express. The config sets `SystemBars.hidden` — that is what performs the
 *  initial hide, and it must stay there, because the plugin posts its own
 *  setHidden() to the main thread after onCreate returns and would otherwise
 *  undo anything hidden here. */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TapkartNfcPlugin::class.java)
        super.onCreate(savedInstanceState)

        // Nothing in Capacitor ever sets this, so the effective policy is
        // BEHAVIOR_DEFAULT: the first edge swipe during a race brings the bars
        // back and LEAVES them back, permanently. TRANSIENT_BARS_BY_SWIPE makes
        // that swipe a peek that auto-hides again, which is the behaviour a
        // full-screen game wants and the one the owner asked for.
        WindowCompat.getInsetsController(window, window.decorView).systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    /** The plugin's handleOnConfigurationChanged re-applies only the bar STYLE,
     *  never `hidden`, so nothing re-hides after a rotate, a fold, or a return
     *  from the recents switcher. Focus is the one edge that covers all three:
     *  a configuration change, a dialog, and a resume all end with focus
     *  returning to this window. */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            WindowCompat.getInsetsController(window, window.decorView)
                .hide(WindowInsetsCompat.Type.systemBars())
        }
    }
}
