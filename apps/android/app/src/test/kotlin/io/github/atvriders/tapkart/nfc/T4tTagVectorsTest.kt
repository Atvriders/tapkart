package io.github.atvriders.tapkart.nfc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Replays the same Type 4 Tag fixture as the TypeScript implementation. */
class T4tTagVectorsTest {
    private data class Row(
        val lineNumber: Int,
        val name: String,
        val ndefUri: String,
        val resetBefore: String,
        val commandHex: String,
        val responseHex: String,
        val selectedAfter: String,
    )

    private fun readRows(resource: String): List<Row> {
        val stream = javaClass.getResourceAsStream(resource)
        assertNotNull("fixture not on the test classpath: $resource", stream)
        val rows = mutableListOf<Row>()
        stream!!.bufferedReader().useLines { lines ->
            lines.forEachIndexed { index, raw ->
                val line = raw.trimEnd('\r')
                if (line.isEmpty() || line.startsWith("#")) return@forEachIndexed
                val parts = line.split("\t")
                assertEquals("line ${index + 1}: expected 6 columns in $line", 6, parts.size)
                rows += Row(index + 1, parts[0], parts[1], parts[2], parts[3], parts[4], parts[5])
            }
        }
        return rows
    }

    private val rows = readRows("/t4t-exchange.tsv")

    @Test
    fun `the fixture is not empty`() {
        assertTrue("t4t-exchange.tsv yielded no rows", rows.isNotEmpty())
    }

    @Test
    fun `every row replays identically`() {
        val tag = T4tTag()
        for (row in rows) {
            when (row.ndefUri) {
                "." -> Unit
                "-" -> tag.setUri(null)
                else -> tag.setUri(row.ndefUri)
            }
            if (row.resetBefore == "1") tag.reset()
            assertEquals(
                "line ${row.lineNumber} (${row.name}): response",
                row.responseHex,
                Hex.encode(tag.process(Hex.decode(row.commandHex))),
            )
            assertEquals(
                "line ${row.lineNumber} (${row.name}): selection",
                row.selectedAfter.uppercase(),
                tag.selected.name,
            )
        }
    }

    @Test
    fun `the fixture covers the happy path and every status word`() {
        val commands = rows.map { it.commandHex }.toSet()
        val responses = rows.map { it.responseHex }.toSet()
        assertTrue(commands.contains("00A4040007D276000085010100"))
        assertTrue(commands.contains("00A4000C02E103"))
        assertTrue(commands.contains("00A4000C02E104"))
        assertTrue(commands.contains("00B0000002"))
        for (sw in listOf("6700", "6985", "6986", "6A82", "6A86", "6B00", "6D00", "6E00")) {
            assertTrue("no row produces $sw", responses.any { it.endsWith(sw) })
        }
    }

    @Test
    fun `the second tap starts from none`() {
        val tag = T4tTag()
        tag.setUri("https://tapkart.example/r/ABCDE")
        assertEquals("9000", Hex.encode(tag.process(Hex.decode("00A4040007D276000085010100"))))
        assertEquals(T4tTag.Selected.APP, tag.selected)
        tag.reset()
        assertEquals(T4tTag.Selected.NONE, tag.selected)
        assertEquals("6986", Hex.encode(tag.process(Hex.decode("00B0000002"))))
        assertEquals("6985", Hex.encode(tag.process(Hex.decode("00A4000C02E103"))))
    }

    @Test
    fun `process never throws`() {
        val tag = T4tTag()
        tag.setUri("https://tapkart.example/r/ABCDE")
        val hostile = listOf(
            "", "00", "00A4", "00A404", "FFFFFFFFFF", "00B000FF00", "00A4040000",
            "00A4040007D2760000850101", "00A404000700000000000000", "00B0000000",
            "00A4040100", "00C0000000", "80B0000002", "00A4040007D27600008501",
        )
        for (hex in hostile) {
            val response = tag.process(Hex.decode(hex))
            assertTrue("$hex produced less than a status word", response.size >= 2)
        }
    }

    @Test
    fun `CC file and constants are published bytes`() {
        assertEquals("000F2000F600FF0406E104040000FF", Hex.encode(T4tTag.CC_FILE))
        assertEquals(15, T4tTag.CC_FILE.size)
        assertEquals("D2760000850101", Hex.encode(T4tTag.AID))
        assertEquals(0x00F6, T4tTag.MLE)
        assertEquals(0x00FF, T4tTag.MLC)
    }

    @Test
    fun `an over-read is truncated`() {
        val tag = T4tTag()
        tag.setUri("https://tapkart.example/r/ABCDE")
        tag.process(Hex.decode("00A4040007D276000085010100"))
        tag.process(Hex.decode("00A4000C02E104"))
        assertEquals("44459000", Hex.encode(tag.process(Hex.decode("00B0001C40"))))
    }

    @Test
    fun `hex accepts spaces and case but rejects fixture separators`() {
        assertEquals("ABCDEF", Hex.encode(Hex.decode("ab CD ef")))
        for (bad in listOf("AA\tBB", "AA\nBB", "A")) {
            try {
                Hex.decode(bad)
                fail("expected Hex.decode to reject ${bad.replace("\t", "\\t").replace("\n", "\\n")}")
            } catch (_: IllegalArgumentException) {
                // Expected: TypeScript strips ASCII spaces only, never TSV separators.
            }
        }
    }
}
