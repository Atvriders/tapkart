package io.github.atvriders.tapkart

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.nfc.NfcAdapter
import android.nfc.cardemulation.CardEmulation
import android.nfc.tech.IsoDep
import android.view.WindowManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import io.github.atvriders.tapkart.nfc.InviteIntent
import io.github.atvriders.tapkart.nfc.InviteMailbox
import io.github.atvriders.tapkart.nfc.InviteReader
import io.github.atvriders.tapkart.nfc.LobbyAdvert
import io.github.atvriders.tapkart.nfc.NdefUri
import io.github.atvriders.tapkart.nfc.TapkartHceService
import org.json.JSONObject

/** ADAPTER. Moves plain NFC data across the Capacitor boundary. */
@CapacitorPlugin(name = "TapkartNfc")
class TapkartNfcPlugin : Plugin() {
    private var readerEnabled = false
    private val inviteMailbox = InviteMailbox()
    /** In-memory intent only: restored after pause/resume, lost on process death. */
    private var requestedAdvertUri: String? = null

    override fun load() {
        super.load()
        // Seed before JavaScript can register. BridgeActivity also forwards its
        // launch intent through handleOnNewIntent after bridge creation; the
        // single-slot mailbox makes that harmless and keeps this independent of
        // the framework's lifecycle ordering.
        val intent = activity.intent
        val uri = InviteIntent.uriFrom(intent?.action, intent?.dataString) ?: return
        inviteMailbox.storeOrDeliver(uri, listenerReady = false)
    }

    @PluginMethod
    fun isSupported(call: PluginCall) {
        val packageManager = activity.packageManager
        val adapter = NfcAdapter.getDefaultAdapter(activity)
        call.resolve(
            JSObject()
                .put("hardware", packageManager.hasSystemFeature(PackageManager.FEATURE_NFC))
                .put(
                    "hce",
                    packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION),
                )
                .put("adapterEnabled", adapter != null && adapter.isEnabled),
        )
    }

    @PluginMethod
    fun startAdvertising(call: PluginCall) {
        val uri = call.getString("uri")
        if (uri == null) {
            call.reject("uri is required")
            return
        }
        try {
            NdefUri.encodeUriRecord(uri)
        } catch (error: IllegalArgumentException) {
            call.reject("uri cannot be encoded into an NDEF record: ${error.message}")
            return
        }

        val adapter = NfcAdapter.getDefaultAdapter(activity)
        if (adapter == null) {
            call.reject("this device has no NFC adapter")
            return
        }
        if (!activity.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION)) {
            call.reject("this device does not support NFC card emulation")
            return
        }
        if (!adapter.isEnabled) {
            call.reject("NFC is disabled")
            return
        }

        requestedAdvertUri = uri
        activateAdvert(uri, adapter)
        call.resolve()
    }

    @PluginMethod
    fun stopAdvertising(call: PluginCall) {
        requestedAdvertUri = null
        clearAdvert()
        call.resolve()
    }

    @PluginMethod
    fun startReader(call: PluginCall) {
        readerEnabled = true
        enableReaderMode()
        call.resolve()
    }

    @PluginMethod
    fun stopReader(call: PluginCall) {
        readerEnabled = false
        disableReaderMode()
        call.resolve()
    }

    @PluginMethod
    fun getPendingInvite(call: PluginCall) {
        val uri = inviteMailbox.consume()
        call.resolve(JSObject().put("uri", uri ?: JSONObject.NULL))
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        val uri = InviteIntent.uriFrom(intent.action, intent.dataString) ?: return
        val delivered = inviteMailbox.storeOrDeliver(uri, hasListeners("inviteUri")) ?: return
        notifyListeners(
            "inviteUri",
            JSObject().put("uri", delivered).put("source", "appLink"),
        )
    }

    override fun handleOnPause() {
        super.handleOnPause()
        disableReaderMode()
        clearAdvert()
    }

    override fun handleOnResume() {
        super.handleOnResume()
        if (readerEnabled) enableReaderMode()
        val uri = requestedAdvertUri
        val adapter = NfcAdapter.getDefaultAdapter(activity)
        if (
            uri != null &&
            adapter != null &&
            adapter.isEnabled &&
            activity.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION)
        ) {
            activateAdvert(uri, adapter)
        }
    }

    private fun activateAdvert(uri: String, adapter: NfcAdapter) {
        LobbyAdvert.uri = uri
        val current = activity
        current.runOnUiThread {
            current.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            CardEmulation.getInstance(adapter).setPreferredService(
                current,
                ComponentName(current, TapkartHceService::class.java),
            )
        }
    }

    private fun clearAdvert() {
        LobbyAdvert.uri = null
        val current = activity
        current.runOnUiThread {
            current.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            val adapter = NfcAdapter.getDefaultAdapter(current)
            if (
                adapter != null &&
                current.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION)
            ) {
                CardEmulation.getInstance(adapter).unsetPreferredService(current)
            }
        }
    }

    private fun enableReaderMode() {
        val adapter = NfcAdapter.getDefaultAdapter(activity) ?: return
        val flags =
            NfcAdapter.FLAG_READER_NFC_A or
                NfcAdapter.FLAG_READER_NFC_B or
                NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or
                NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS
        adapter.enableReaderMode(
            activity,
            { tag ->
                val isoDep = IsoDep.get(tag)
                if (isoDep != null) {
                    val uri = InviteReader.read(isoDep)
                    if (uri != null) {
                        notifyListeners(
                            "inviteUri",
                            JSObject().put("uri", uri).put("source", "tag"),
                        )
                    }
                }
            },
            flags,
            null,
        )
    }

    private fun disableReaderMode() {
        val adapter = NfcAdapter.getDefaultAdapter(activity) ?: return
        adapter.disableReaderMode(activity)
    }
}
