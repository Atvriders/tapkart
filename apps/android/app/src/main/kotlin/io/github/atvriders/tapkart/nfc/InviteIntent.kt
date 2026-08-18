package io.github.atvriders.tapkart.nfc

/** PURE. Resolves both Android invite entry points through one path. */
object InviteIntent {
    const val ACTION_VIEW: String = "android.intent.action.VIEW"
    const val ACTION_NDEF_DISCOVERED: String = "android.nfc.action.NDEF_DISCOVERED"

    fun uriFrom(action: String?, dataUri: String?): String? {
        if (action != ACTION_VIEW && action != ACTION_NDEF_DISCOVERED) return null
        if (dataUri == null || dataUri.isBlank()) return null
        return dataUri
    }
}
