package io.github.atvriders.tapkart.nfc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Both native invite entry points feed the same pure resolver. */
class InviteIntentTest {
    private val uris = listOf(
        "https://tapkart.example/r/ABCDE",
        "https://kart.example.com/r/ABCDE",
        "https://tapkart.example/r/ABCDE?utm=1",
        "http://tapkart.example/r/ABCDE",
        "not a uri at all",
        "",
        "   ",
        "\t\n",
        null,
    )

    @Test
    fun `both entry points resolve identically`() {
        for (uri in uris) {
            assertEquals(
                InviteIntent.uriFrom(InviteIntent.ACTION_VIEW, uri),
                InviteIntent.uriFrom(InviteIntent.ACTION_NDEF_DISCOVERED, uri),
            )
        }
    }

    @Test
    fun `usable URI comes back unchanged`() {
        for (uri in uris.filterNotNull().filter { it.isNotBlank() }) {
            assertEquals(uri, InviteIntent.uriFrom(InviteIntent.ACTION_VIEW, uri))
            assertEquals(uri, InviteIntent.uriFrom(InviteIntent.ACTION_NDEF_DISCOVERED, uri))
        }
    }

    @Test
    fun `null empty and blank are null`() {
        for (action in listOf(InviteIntent.ACTION_VIEW, InviteIntent.ACTION_NDEF_DISCOVERED)) {
            assertNull(InviteIntent.uriFrom(action, null))
            assertNull(InviteIntent.uriFrom(action, ""))
            assertNull(InviteIntent.uriFrom(action, "   "))
            assertNull(InviteIntent.uriFrom(action, "\t\n"))
        }
    }

    @Test
    fun `no other action produces a URI`() {
        val uri = "https://tapkart.example/r/ABCDE"
        for (action in listOf(
            null,
            "",
            "android.intent.action.MAIN",
            "android.nfc.action.TECH_DISCOVERED",
            "android.nfc.action.TAG_DISCOVERED",
            "ACTION_VIEW",
        )) {
            assertNull(InviteIntent.uriFrom(action, uri))
        }
    }

    @Test
    fun `action names are exact`() {
        assertEquals("android.intent.action.VIEW", InviteIntent.ACTION_VIEW)
        assertEquals("android.nfc.action.NDEF_DISCOVERED", InviteIntent.ACTION_NDEF_DISCOVERED)
    }
}
