package io.github.atvriders.tapkart.nfc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Proves the invite is exactly one URI record, with no Android Application Record. */
class NoApplicationRecordTest {
    private val file = NdefUri.buildNdefFile("https://tapkart.example/r/ABCDE")

    @Test
    fun `the message is exactly the published fixture bytes`() {
        assertEquals(
            "001CD1011855047461706B6172742E6578616D706C652F722F4142434445",
            Hex.encode(file),
        )
    }

    @Test
    fun `there is exactly one record, and it is the first and the last`() {
        val header = file[2].toInt() and 0xFF
        assertEquals("MB must be set: this is the first record", 0x80, header and 0x80)
        assertEquals("ME must be set: this is also the LAST record", 0x40, header and 0x40)
        assertEquals("CF must be clear: the record is not chunked", 0x00, header and 0x20)
        assertEquals("SR must be set: a short record", 0x10, header and 0x10)
        assertEquals("IL must be clear: no ID field", 0x00, header and 0x08)
        assertEquals("TNF must be 001, NFC Forum well-known type", 0x01, header and 0x07)
    }

    @Test
    fun `NLEN leaves no room for a second record`() {
        val nlen = ((file[0].toInt() and 0xFF) shl 8) or (file[1].toInt() and 0xFF)
        val payloadLength = file[4].toInt() and 0xFF
        assertEquals(4 + payloadLength, nlen)
        assertEquals(2 + nlen, file.size)
    }

    @Test
    fun `the message contains no android application record`() {
        val ascii = String(file, Charsets.ISO_8859_1)
        assertFalse("an Android Application Record is present", ascii.contains("android.com:pkg"))
        assertFalse("a package name is present", ascii.contains("io.github.atvriders.tapkart"))
    }

    @Test
    fun `an empty advert is still a single well-formed record-free file`() {
        assertEquals("0000", Hex.encode(NdefUri.buildNdefFile(null)))
        assertTrue(NdefUri.parseNdefFile(NdefUri.buildNdefFile(null)) == null)
    }
}
