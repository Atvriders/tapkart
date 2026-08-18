package io.github.atvriders.tapkart.nfc

/** PURE. Routes one Android launch URI either to live JavaScript or to the
 * consume-once pending slot used while the WebView has no listener. */
internal class InviteMailbox {
    private var pending: String? = null

    @Synchronized
    fun storeOrDeliver(uri: String, listenerReady: Boolean): String? {
        if (listenerReady) {
            // A live navigation supersedes any launch URI queued before the
            // listener came up. Delivering both would join the wrong room or
            // process the same launch twice.
            pending = null
            return uri
        }
        // Navigation is state, not a log: if two links arrive while JavaScript
        // is unavailable, returning to the most recent one matches Android.
        pending = uri
        return null
    }

    @Synchronized
    fun consume(): String? {
        val uri = pending
        pending = null
        return uri
    }
}
