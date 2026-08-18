package io.github.atvriders.tapkart.nfc

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/** ADAPTER. Android supplies APDUs; T4tTag makes every protocol decision. */
class TapkartHceService : HostApduService() {
    private val tag = T4tTag()

    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
        tag.setUri(LobbyAdvert.uri)
        return tag.process(commandApdu ?: ByteArray(0))
    }

    override fun onDeactivated(reason: Int) {
        tag.reset()
    }
}
