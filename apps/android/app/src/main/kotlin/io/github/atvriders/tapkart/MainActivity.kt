package io.github.atvriders.tapkart

import android.os.Bundle
import com.getcapacitor.BridgeActivity

/** ADAPTER. Registers the local plugin before Capacitor builds the bridge. */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TapkartNfcPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
