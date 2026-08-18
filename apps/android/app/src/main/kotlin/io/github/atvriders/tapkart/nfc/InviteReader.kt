package io.github.atvriders.tapkart.nfc

import android.nfc.tech.IsoDep
import java.io.IOException

/** ADAPTER. Drives packages/invite/src/reader.ts's exchange over IsoDep. */
object InviteReader {
    private const val CC_MIN_LENGTH = 15
    private const val CC_MLE_OFFSET = 3
    private const val CC_TLV_START = 7
    private const val NDEF_TLV_TAG = 0x04
    private const val NDEF_TLV_LENGTH = 0x06
    private const val CC_FILE_ID = 0xE103

    private val SELECT_APP = byteArrayOf(
        0x00, 0xA4.toByte(), 0x04, 0x00, 0x07,
        0xD2.toByte(), 0x76, 0x00, 0x00, 0x85.toByte(), 0x01, 0x01, 0x00,
    )

    fun read(isoDep: IsoDep): String? {
        try {
            isoDep.connect()

            if (!isOk(isoDep.transceive(SELECT_APP))) return null
            if (!isOk(isoDep.transceive(selectFile(CC_FILE_ID)))) return null

            // Match the browser-side reader: CCLEN first, then the advertised file.
            val ccLengthBytes = readBinary(isoDep, 0, 2) ?: return null
            if (ccLengthBytes.size < 2) return null
            val ccLength = u16(ccLengthBytes[0], ccLengthBytes[1])
            if (ccLength < CC_MIN_LENGTH) return null

            val ccRest = readBinary(isoDep, 2, minOf(ccLength - 2, T4tTag.MLE)) ?: return null
            if (ccRest.size < CC_MIN_LENGTH - 2) return null
            val cc = ByteArray(2 + ccRest.size)
            cc[0] = ccLengthBytes[0]
            cc[1] = ccLengthBytes[1]
            ccRest.copyInto(cc, 2)

            val advertisedMle = u16(cc[CC_MLE_OFFSET], cc[CC_MLE_OFFSET + 1])
            if (advertisedMle < 1) return null
            val chunkSize = minOf(advertisedMle, T4tTag.MLE)

            val ndefFileId = ndefFileIdFrom(cc) ?: return null
            if (!isOk(isoDep.transceive(selectFile(ndefFileId)))) return null

            val nlenBytes = readBinary(isoDep, 0, 2) ?: return null
            if (nlenBytes.size < 2) return null
            val nlen = u16(nlenBytes[0], nlenBytes[1])
            if (nlen == 0) return null
            if (2 + nlen > 0xFFFF) return null

            val message = ByteArray(nlen)
            var read = 0
            while (read < nlen) {
                val chunk = readBinary(isoDep, 2 + read, minOf(chunkSize, nlen - read)) ?: return null
                if (chunk.isEmpty() || chunk.size > nlen - read) return null
                chunk.copyInto(message, read)
                read += chunk.size
            }

            val file = ByteArray(2 + nlen)
            file[0] = nlenBytes[0]
            file[1] = nlenBytes[1]
            message.copyInto(file, 2)
            return NdefUri.parseNdefFile(file)
        } catch (_: IOException) {
            return null
        } catch (_: IllegalArgumentException) {
            return null
        } finally {
            try {
                isoDep.close()
            } catch (_: IOException) {
                // The link is already gone.
            }
        }
    }

    private fun selectFile(fileId: Int): ByteArray = byteArrayOf(
        0x00,
        0xA4.toByte(),
        0x00,
        0x0C,
        0x02,
        ((fileId ushr 8) and 0xFF).toByte(),
        (fileId and 0xFF).toByte(),
    )

    private fun ndefFileIdFrom(cc: ByteArray): Int? {
        var offset = CC_TLV_START
        while (offset + 1 < cc.size) {
            val tag = cc[offset].toInt() and 0xFF
            val length = cc[offset + 1].toInt() and 0xFF
            if (offset + 2 + length > cc.size) return null
            if (tag == NDEF_TLV_TAG && length == NDEF_TLV_LENGTH) {
                return u16(cc[offset + 2], cc[offset + 3])
            }
            offset += 2 + length
        }
        return null
    }

    private fun readBinary(isoDep: IsoDep, offset: Int, length: Int): ByteArray? {
        val command = byteArrayOf(
            0x00,
            0xB0.toByte(),
            ((offset ushr 8) and 0xFF).toByte(),
            (offset and 0xFF).toByte(),
            (length and 0xFF).toByte(),
        )
        val response = isoDep.transceive(command)
        if (!isOk(response)) return null
        return response.copyOfRange(0, response.size - 2)
    }

    private fun isOk(response: ByteArray): Boolean =
        response.size >= 2 &&
            (response[response.size - 2].toInt() and 0xFF) == 0x90 &&
            (response[response.size - 1].toInt() and 0xFF) == 0x00

    private fun u16(high: Byte, low: Byte): Int =
        ((high.toInt() and 0xFF) shl 8) or (low.toInt() and 0xFF)
}
