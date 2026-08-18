package io.github.atvriders.tapkart.nfc

/** PURE. Mirrors packages/invite/src/uri.ts, including validation order. */
object NdefUri {
    const val MAX_INVITE_URI_BYTES: Int = 250

    private const val URI_RECORD_HEADER = 0xD1
    private const val URI_RECORD_TYPE = 0x55
    private const val MAX_SHORT_PAYLOAD = 255

    private val PREFIXES: List<String> = listOf(
        "",
        "http://www.",
        "https://www.",
        "http://",
        "https://",
        "tel:",
        "mailto:",
        "ftp://anonymous:anonymous@",
        "ftp://ftp.",
        "ftps://",
        "sftp://",
        "smb://",
        "nfs://",
        "ftp://",
        "dav://",
        "news:",
        "telnet://",
        "imap:",
        "rtsp://",
        "urn:",
        "pop:",
        "sip:",
        "sips:",
        "tftp:",
        "btspp://",
        "btl2cap://",
        "btgoep://",
        "tcpobex://",
        "irdaobex://",
        "file://",
        "urn:epc:id:",
        "urn:epc:tag:",
        "urn:epc:pat:",
        "urn:epc:raw:",
        "urn:epc:",
        "urn:nfc:",
    )

    fun encodeUriRecord(uri: String): ByteArray {
        var prefixCode = 0
        var prefixLength = 0
        for (i in 1 until PREFIXES.size) {
            val prefix = PREFIXES[i]
            if (prefix.length > prefixLength && uri.startsWith(prefix)) {
                prefixCode = i
                prefixLength = prefix.length
            }
        }

        val rest = utf8Encode(uri.substring(prefixLength))
        val payloadLength = 1 + rest.size
        require(payloadLength <= MAX_SHORT_PAYLOAD) {
            "encodeUriRecord: payload is $payloadLength bytes, over the 255-byte short-record limit"
        }

        val record = ByteArray(4 + payloadLength)
        record[0] = URI_RECORD_HEADER.toByte()
        record[1] = 0x01
        record[2] = payloadLength.toByte()
        record[3] = URI_RECORD_TYPE.toByte()
        record[4] = prefixCode.toByte()
        rest.copyInto(record, 5)
        return record
    }

    fun buildNdefFile(uri: String?): ByteArray {
        if (uri == null) return byteArrayOf(0, 0)
        val record = encodeUriRecord(uri)
        val file = ByteArray(2 + record.size)
        file[0] = ((record.size ushr 8) and 0xFF).toByte()
        file[1] = (record.size and 0xFF).toByte()
        record.copyInto(file, 2)
        return file
    }

    fun parseNdefFile(file: ByteArray): String? {
        require(file.size >= 2) {
            "parseNdefFile: file is ${file.size} bytes, shorter than the 2-byte NLEN"
        }
        val nlen = ((file[0].toInt() and 0xFF) shl 8) or (file[1].toInt() and 0xFF)
        if (nlen == 0) return null
        require(2 + nlen <= file.size) {
            "parseNdefFile: NLEN $nlen exceeds the ${file.size - 2} message bytes present"
        }
        return decodeUriRecord(file.copyOfRange(2, 2 + nlen))
    }

    private fun decodeUriRecord(record: ByteArray): String {
        require(record.size >= 4) {
            "decodeUriRecord: record is ${record.size} bytes, shorter than the 4-byte header"
        }
        require((record[0].toInt() and 0xFF) == URI_RECORD_HEADER) {
            "decodeUriRecord: header is 0x${hex2(record[0])}, not 0xD1 (single short well-known record)"
        }
        require((record[1].toInt() and 0xFF) == 0x01) {
            "decodeUriRecord: type length is ${record[1].toInt() and 0xFF}, not 1"
        }
        require((record[3].toInt() and 0xFF) == URI_RECORD_TYPE) {
            "decodeUriRecord: type byte is 0x${hex2(record[3])}, not 0x55 ('U')"
        }
        val payloadLength = record[2].toInt() and 0xFF
        require(record.size == 4 + payloadLength) {
            "decodeUriRecord: declared payload length $payloadLength does not match " +
                "the ${record.size - 4} bytes present"
        }
        require(payloadLength >= 1) {
            "decodeUriRecord: payload is empty; a URI record carries at least a prefix code"
        }
        val prefixCode = record[4].toInt() and 0xFF
        require(prefixCode < PREFIXES.size) {
            "decodeUriRecord: prefix code 0x${hex2(record[4])} is outside the abbreviation table " +
                "(0x00..0x23)"
        }
        return PREFIXES[prefixCode] + utf8Decode(record.copyOfRange(5, record.size))
    }

    private fun utf8Encode(value: String): ByteArray {
        var index = 0
        while (index < value.length) {
            val character = value[index]
            if (character.isHighSurrogate()) {
                require(index + 1 < value.length && value[index + 1].isLowSurrogate()) {
                    "encodeUriRecord: unpaired surrogate at index $index of the record payload"
                }
                index += 2
            } else {
                require(!character.isLowSurrogate()) {
                    "encodeUriRecord: unpaired surrogate at index $index of the record payload"
                }
                index += 1
            }
        }
        return value.toByteArray(Charsets.UTF_8)
    }

    private fun utf8Decode(bytes: ByteArray): String {
        val out = StringBuilder()
        var index = 0
        while (index < bytes.size) {
            val lead = bytes[index].toInt() and 0xFF
            val start: Int
            val needed: Int
            val minimum: Int
            when {
                lead < 0x80 -> { start = lead; needed = 0; minimum = 0x00 }
                (lead and 0xE0) == 0xC0 -> { start = lead and 0x1F; needed = 1; minimum = 0x80 }
                (lead and 0xF0) == 0xE0 -> { start = lead and 0x0F; needed = 2; minimum = 0x800 }
                (lead and 0xF8) == 0xF0 -> { start = lead and 0x07; needed = 3; minimum = 0x10000 }
                else -> throw IllegalArgumentException(
                    "utf8Decode: invalid lead byte 0x${hex2(bytes[index])} at index $index",
                )
            }
            if (index + needed >= bytes.size) {
                throw IllegalArgumentException("utf8Decode: truncated sequence at index $index")
            }
            var codePoint = start
            for (offset in 1..needed) {
                val continuation = bytes[index + offset].toInt() and 0xFF
                if ((continuation and 0xC0) != 0x80) {
                    throw IllegalArgumentException(
                        "utf8Decode: invalid continuation byte 0x${hex2(bytes[index + offset])} " +
                            "at index ${index + offset}",
                    )
                }
                codePoint = (codePoint shl 6) or (continuation and 0x3F)
            }
            if (codePoint < minimum) {
                throw IllegalArgumentException("utf8Decode: overlong encoding at index $index")
            }
            if (codePoint > 0x10FFFF) {
                throw IllegalArgumentException("utf8Decode: code point out of range at index $index")
            }
            if (codePoint in 0xD800..0xDFFF) {
                throw IllegalArgumentException("utf8Decode: surrogate code point at index $index")
            }
            if (codePoint >= 0x10000) {
                val surrogate = codePoint - 0x10000
                out.append((0xD800 + (surrogate shr 10)).toChar())
                out.append((0xDC00 + (surrogate and 0x3FF)).toChar())
            } else {
                out.append(codePoint.toChar())
            }
            index += needed + 1
        }
        return out.toString()
    }

    private fun hex2(byte: Byte): String = Hex.encode(byteArrayOf(byte))
}
