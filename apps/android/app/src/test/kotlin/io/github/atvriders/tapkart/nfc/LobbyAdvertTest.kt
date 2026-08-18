package io.github.atvriders.tapkart.nfc

import java.lang.reflect.Modifier
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** JVM coverage for the one adapter state holder that has no android.* import. */
class LobbyAdvertTest {
    @After
    fun clear() {
        LobbyAdvert.uri = null
    }

    @Test
    fun `starts null and holds what it is given`() {
        assertNull(LobbyAdvert.uri)
        LobbyAdvert.uri = "https://tapkart.example/r/ABCDE"
        assertEquals("https://tapkart.example/r/ABCDE", LobbyAdvert.uri)
        LobbyAdvert.uri = null
        assertNull(LobbyAdvert.uri)
    }

    @Test
    fun `the advert field is volatile, because two threads touch it`() {
        val field = LobbyAdvert::class.java.getDeclaredField("uri")
        assertTrue("LobbyAdvert.uri must be @Volatile", Modifier.isVolatile(field.modifiers))
    }

    @Test
    fun `nothing here persists the advert`() {
        for (method in LobbyAdvert::class.java.declaredMethods) {
            assertFalse(
                "LobbyAdvert.${method.name} takes a Context — persistence was deleted",
                method.parameterTypes.any { it.name == "android.content.Context" },
            )
        }
        for (field in LobbyAdvert::class.java.declaredFields) {
            val name = field.name.uppercase()
            assertFalse(
                "LobbyAdvert.${field.name} looks like a SharedPreferences key",
                name.contains("PREF") || name.startsWith("KEY_"),
            )
        }
    }
}
