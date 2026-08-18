package io.github.atvriders.tapkart.nfc

/** PURE. Mirrors packages/invite/src/t4t.ts, including APDU check order. */
class T4tTag {
    enum class Selected { NONE, APP, CC, NDEF }

    var selected: Selected = Selected.NONE
        private set

    private var ndefFile: ByteArray = byteArrayOf(0, 0)

    fun setUri(uri: String?) {
        ndefFile = NdefUri.buildNdefFile(uri)
    }

    fun reset() {
        selected = Selected.NONE
    }

    /** Every malformed input maps to a status word; this function never throws. */
    fun process(apdu: ByteArray): ByteArray {
        if (apdu.size < 4) return sw(SW_WRONG_LENGTH)
        val cla = apdu[0].toInt() and 0xFF
        val ins = apdu[1].toInt() and 0xFF
        val p1 = apdu[2].toInt() and 0xFF
        val p2 = apdu[3].toInt() and 0xFF
        if (cla != 0x00) return sw(SW_CLA_NOT_SUPPORTED)
        if (ins != INS_SELECT && ins != INS_READ_BINARY) return sw(SW_INS_NOT_SUPPORTED)

        var lc = 0
        var dataOffset = 0
        var le = -1
        val b4 = if (apdu.size > 4) apdu[4].toInt() and 0xFF else 0
        when {
            apdu.size == 4 -> Unit
            apdu.size == 5 -> le = if (b4 == 0) 256 else b4
            b4 == 0 -> return sw(SW_WRONG_LENGTH)
            apdu.size == 5 + b4 -> {
                lc = b4
                dataOffset = 5
            }
            apdu.size == 6 + b4 -> {
                lc = b4
                dataOffset = 5
                val trailing = apdu[5 + b4].toInt() and 0xFF
                le = if (trailing == 0) 256 else trailing
            }
            else -> return sw(SW_WRONG_LENGTH)
        }

        if (ins == INS_SELECT) {
            val p1p2 = (p1 shl 8) or p2
            if (p1p2 == 0x0400) {
                if (dataOffset == 0 || lc != AID.size) return sw(SW_FILE_NOT_FOUND)
                for (index in AID.indices) {
                    if (apdu[dataOffset + index] != AID[index]) return sw(SW_FILE_NOT_FOUND)
                }
                selected = Selected.APP
                return sw(SW_OK)
            }
            if (p1p2 == 0x000C) {
                if (selected == Selected.NONE) return sw(SW_CONDITIONS_NOT_SATISFIED)
                if (dataOffset == 0 || lc != 2) return sw(SW_FILE_NOT_FOUND)
                val fileId = ((apdu[dataOffset].toInt() and 0xFF) shl 8) or
                    (apdu[dataOffset + 1].toInt() and 0xFF)
                when (fileId) {
                    CC_FILE_ID -> selected = Selected.CC
                    NDEF_FILE_ID -> selected = Selected.NDEF
                    else -> return sw(SW_FILE_NOT_FOUND)
                }
                return sw(SW_OK)
            }
            return sw(SW_INCORRECT_P1P2)
        }

        if (apdu.size != 5) return sw(SW_WRONG_LENGTH)
        if (selected == Selected.NONE || selected == Selected.APP) {
            return sw(SW_COMMAND_NOT_ALLOWED)
        }
        val file = if (selected == Selected.CC) CC_FILE else ndefFile
        val offset = (p1 shl 8) or p2
        if (offset >= file.size) return sw(SW_WRONG_PARAMETERS)
        val count = minOf(le, MLE, file.size - offset)
        val out = ByteArray(count + 2)
        file.copyInto(out, 0, offset, offset + count)
        out[count] = ((SW_OK ushr 8) and 0xFF).toByte()
        out[count + 1] = (SW_OK and 0xFF).toByte()
        return out
    }

    private fun sw(status: Int): ByteArray =
        byteArrayOf(((status ushr 8) and 0xFF).toByte(), (status and 0xFF).toByte())

    companion object {
        val AID: ByteArray = byteArrayOf(
            0xD2.toByte(), 0x76, 0x00, 0x00, 0x85.toByte(), 0x01, 0x01,
        )

        val CC_FILE: ByteArray = byteArrayOf(
            0x00, 0x0F,
            0x20,
            0x00, 0xF6.toByte(),
            0x00, 0xFF.toByte(),
            0x04,
            0x06,
            0xE1.toByte(), 0x04,
            0x04, 0x00,
            0x00,
            0xFF.toByte(),
        )

        const val MLE: Int = 0x00F6
        const val MLC: Int = 0x00FF

        private const val CC_FILE_ID = 0xE103
        private const val NDEF_FILE_ID = 0xE104
        private const val INS_SELECT = 0xA4
        private const val INS_READ_BINARY = 0xB0

        private const val SW_OK = 0x9000
        private const val SW_WRONG_LENGTH = 0x6700
        private const val SW_CONDITIONS_NOT_SATISFIED = 0x6985
        private const val SW_COMMAND_NOT_ALLOWED = 0x6986
        private const val SW_WRONG_PARAMETERS = 0x6B00
        private const val SW_FILE_NOT_FOUND = 0x6A82
        private const val SW_INCORRECT_P1P2 = 0x6A86
        private const val SW_INS_NOT_SUPPORTED = 0x6D00
        private const val SW_CLA_NOT_SUPPORTED = 0x6E00
    }
}
