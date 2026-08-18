package io.github.atvriders.tapkart.nfc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Replays the same NDEF URI fixture as the TypeScript implementation. */
class NdefUriVectorsTest {
    private data class Row(val lineNumber: Int, val uri: String?, val fileHex: String)

    private val rows: List<Row> = run {
        val stream = javaClass.getResourceAsStream("/ndef-uri.tsv")
        assertNotNull("fixture not on the test classpath: /ndef-uri.tsv", stream)
        val out = mutableListOf<Row>()
        stream!!.bufferedReader().useLines { lines ->
            lines.forEachIndexed { index, raw ->
                val line = raw.trimEnd('\r')
                if (line.isEmpty() || line.startsWith("#")) return@forEachIndexed
                val parts = line.split("\t")
                assertEquals("line ${index + 1}: expected 2 columns in $line", 2, parts.size)
                out += Row(index + 1, if (parts[0] == "-") null else parts[0], parts[1])
            }
        }
        out
    }

    private fun expectThrows(fragment: String, body: () -> Unit) {
        try {
            body()
            fail("expected a throw containing \"$fragment\"")
        } catch (e: IllegalArgumentException) {
            assertTrue(
                "message was \"${e.message}\", expected it to contain \"$fragment\"",
                e.message?.contains(fragment) == true,
            )
        }
    }

    @Test
    fun `the fixture is not empty`() {
        assertTrue("ndef-uri.tsv yielded no rows", rows.isNotEmpty())
    }

    @Test
    fun `every row builds to exactly the published bytes`() {
        for (row in rows) {
            assertEquals(
                "line ${row.lineNumber}: buildNdefFile(${row.uri})",
                row.fileHex,
                Hex.encode(NdefUri.buildNdefFile(row.uri)),
            )
        }
    }

    @Test
    fun `every row round trips`() {
        for (row in rows) {
            assertEquals(row.uri, NdefUri.parseNdefFile(Hex.decode(row.fileHex)))
        }
    }

    @Test
    fun `fixture covers empty and https`() {
        assertTrue(rows.any { it.uri == null && it.fileHex == "0000" })
        assertTrue(rows.any { it.uri != null && it.uri.startsWith("https://") })
    }

    @Test
    fun `empty file is exactly two zero bytes`() {
        assertEquals("0000", Hex.encode(NdefUri.buildNdefFile(null)))
        assertNull(NdefUri.parseNdefFile(Hex.decode("0000")))
    }

    @Test
    fun `golden record abbreviates https and has no AAR`() {
        val record = NdefUri.encodeUriRecord("https://tapkart.example/r/ABCDE")
        assertEquals(
            "D1011855047461706B6172742E6578616D706C652F722F4142434445",
            Hex.encode(record),
        )
        assertEquals(28, record.size)
    }

    @Test
    fun `length is measured in UTF-8 bytes`() {
        val overLong = "https://" + "é".repeat(130)
        assertTrue(overLong.length < 250)
        expectThrows("over the 255-byte short-record limit") {
            NdefUri.encodeUriRecord(overLong)
        }
        assertEquals(250, NdefUri.MAX_INVITE_URI_BYTES)
    }

    @Test
    fun `malformed files throw in TypeScript order`() {
        assertNull(NdefUri.parseNdefFile(Hex.decode("0000")))
        expectThrows("shorter than the 2-byte NLEN") { NdefUri.parseNdefFile(ByteArray(0)) }
        expectThrows("shorter than the 2-byte NLEN") { NdefUri.parseNdefFile(Hex.decode("00")) }
        expectThrows("exceeds") { NdefUri.parseNdefFile(Hex.decode("00FFD101185504")) }
        expectThrows("shorter than the 4-byte header") {
            NdefUri.parseNdefFile(Hex.decode("0003D10118"))
        }
        expectThrows("not 0xD1") { NdefUri.parseNdefFile(Hex.decode("000791011855047461")) }
        expectThrows("type length is 2") { NdefUri.parseNdefFile(Hex.decode("0005D102185504")) }
        expectThrows("not 0x55") { NdefUri.parseNdefFile(Hex.decode("0006D10102540441")) }
        expectThrows("does not match") { NdefUri.parseNdefFile(Hex.decode("0007D1011855047461")) }
        expectThrows("payload is empty") { NdefUri.parseNdefFile(Hex.decode("0004D1010055")) }
        expectThrows("outside the abbreviation table") {
            NdefUri.parseNdefFile(Hex.decode("0006D10102552461"))
        }
    }

    @Test
    fun `malformed UTF-8 throws`() {
        expectThrows("truncated sequence at index 0") {
            NdefUri.parseNdefFile(Hex.decode("0006D101025504C3"))
        }
        expectThrows("overlong encoding at index 0") {
            NdefUri.parseNdefFile(Hex.decode("0007D101035504C080"))
        }
    }

    @Test
    fun `unpaired surrogate throws`() {
        expectThrows("unpaired surrogate at index 18") {
            NdefUri.encodeUriRecord("https://tapkart.example/r/\uD83D")
        }
        expectThrows("unpaired surrogate at index 18") {
            NdefUri.encodeUriRecord("https://tapkart.example/r/\uDE00")
        }
        val paired = NdefUri.encodeUriRecord("https://tapkart.example/r/😀")
        assertEquals(4 + 1 + 18 + 4, paired.size)
    }

    @Test
    fun `foreign prefix round trips`() {
        assertEquals("D101065503746573742E", Hex.encode(NdefUri.encodeUriRecord("http://test.")))
        assertEquals(
            "http://test.",
            NdefUri.parseNdefFile(Hex.decode("000AD101065503746573742E")),
        )
    }
}
