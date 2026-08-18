package io.github.atvriders.tapkart.nfc

/** PURE. Mirrors packages/invite/src/hex.ts. */
object Hex {
    private const val DIGITS = "0123456789ABCDEF"

    fun encode(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xFF
            out.append(DIGITS[v ushr 4])
            out.append(DIGITS[v and 0x0F])
        }
        return out.toString()
    }

    /**
     * Accepts uppercase, lowercase, and embedded ASCII spaces. Tabs and line
     * breaks remain invalid so fixture separators cannot be silently consumed.
     */
    fun decode(s: String): ByteArray {
        val cleaned = s.filterNot { it == ' ' }

        // Match hex.ts: reject invalid characters before reporting odd length.
        for (c in cleaned) digit(c)
        require(cleaned.length % 2 == 0) { "hex string has an odd length: ${cleaned.length}" }

        val out = ByteArray(cleaned.length / 2)
        for (i in out.indices) {
            out[i] = ((digit(cleaned[i * 2]) shl 4) or digit(cleaned[i * 2 + 1])).toByte()
        }
        return out
    }

    private fun digit(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> throw IllegalArgumentException("not a hex character: '$c'")
    }
}
