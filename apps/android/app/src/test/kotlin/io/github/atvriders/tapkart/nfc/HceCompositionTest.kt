package io.github.atvriders.tapkart.nfc

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/** Drives the pure composition performed by TapkartHceService. */
class HceCompositionTest {
    private val selectApp = "00A4040007D276000085010100"
    private val selectNdef = "00A4000C02E104"
    private val readNlen = "00B0000002"
    private val readBody = "00B000021C"
    private val goldenUri = "https://tapkart.example/r/ABCDE"
    private val goldenRecord = "D1011855047461706B6172742E6578616D706C652F722F4142434445"

    @After
    fun clear() {
        LobbyAdvert.uri = null
    }

    private fun serve(tag: T4tTag, commandHex: String): String {
        tag.setUri(LobbyAdvert.uri)
        return Hex.encode(tag.process(Hex.decode(commandHex)))
    }

    @Test
    fun `an advertising host answers the golden exchange`() {
        LobbyAdvert.uri = goldenUri
        val tag = T4tTag()
        assertEquals("9000", serve(tag, selectApp))
        assertEquals("9000", serve(tag, selectNdef))
        assertEquals("001C9000", serve(tag, readNlen))
        assertEquals("${goldenRecord}9000", serve(tag, readBody))
    }

    @Test
    fun `a host that is not advertising is a well-formed empty tag`() {
        LobbyAdvert.uri = null
        val tag = T4tTag()
        assertEquals("9000", serve(tag, selectApp))
        assertEquals("9000", serve(tag, selectNdef))
        assertEquals("00009000", serve(tag, readNlen))
    }

    @Test
    fun `clearing the advert mid-session stops serving the invite`() {
        LobbyAdvert.uri = goldenUri
        val tag = T4tTag()
        serve(tag, selectApp)
        serve(tag, selectNdef)
        assertEquals("001C9000", serve(tag, readNlen))
        LobbyAdvert.uri = null
        assertEquals("00009000", serve(tag, readNlen))
    }

    @Test
    fun `the second tap of the evening works, because onDeactivated resets`() {
        LobbyAdvert.uri = goldenUri
        val tag = T4tTag()
        assertEquals("9000", serve(tag, selectApp))
        assertEquals("9000", serve(tag, selectNdef))
        assertEquals("001C9000", serve(tag, readNlen))

        tag.reset()

        assertEquals("6986", serve(tag, readNlen))
        assertEquals("9000", serve(tag, selectApp))
        assertEquals("9000", serve(tag, selectNdef))
        assertEquals("001C9000", serve(tag, readNlen))
    }

    @Test
    fun `a null command APDU becomes a status word, not a crash`() {
        val tag = T4tTag()
        assertEquals("6700", Hex.encode(tag.process(ByteArray(0))))
    }

    @Test
    fun `the fixture file backing these rows is present`() {
        assertNotNull(
            "fixture not on the test classpath: /t4t-exchange.tsv",
            javaClass.getResourceAsStream("/t4t-exchange.tsv"),
        )
    }
}
