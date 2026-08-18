package io.github.atvriders.tapkart.nfc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InviteMailboxTest {
    private val first = "https://tapkart.example/r/ABCDE"
    private val second = "https://tapkart.example/r/FGHJK"

    @Test
    fun `an invite arriving before registration is consumed exactly once`() {
        val mailbox = InviteMailbox()

        assertNull(mailbox.storeOrDeliver(first, listenerReady = false))
        assertEquals(first, mailbox.consume())
        assertNull(mailbox.consume())
    }

    @Test
    fun `an invite with a live listener is delivered and never stored`() {
        val mailbox = InviteMailbox()

        assertEquals(first, mailbox.storeOrDeliver(first, listenerReady = true))
        assertNull(mailbox.consume())
    }

    @Test
    fun `a live warm invite clears an older seeded launch instead of duplicating it`() {
        val mailbox = InviteMailbox()

        assertNull(mailbox.storeOrDeliver(first, listenerReady = false))
        assertEquals(second, mailbox.storeOrDeliver(second, listenerReady = true))
        assertNull(mailbox.consume())
    }

    @Test
    fun `a warm navigation replaces the seeded cold-start intent before JavaScript loads`() {
        val mailbox = InviteMailbox()

        // TapkartNfcPlugin.load seeds the launch intent, then a later
        // handleOnNewIntent may arrive before getPendingInvite is callable.
        assertNull(mailbox.storeOrDeliver(first, listenerReady = false))
        assertNull(mailbox.storeOrDeliver(second, listenerReady = false))
        assertEquals(second, mailbox.consume())
        assertNull(mailbox.consume())
    }
}
