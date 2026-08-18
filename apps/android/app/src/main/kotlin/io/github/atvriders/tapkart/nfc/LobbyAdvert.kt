package io.github.atvriders.tapkart.nfc

/**
 * ADAPTER — the one process-global NFC advert. The plugin is its sole writer;
 * the HCE service reads it from a binder thread. It is intentionally never
 * persisted, so a backgrounded or restarted host cannot advertise a stale room.
 */
object LobbyAdvert {
    @Volatile
    var uri: String? = null
}
