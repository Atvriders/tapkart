### Task 11: the Kotlin adapters, and no Android Application Record

**Files:**
- Create: `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/LobbyAdvert.kt`
- Create: `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/TapkartHceService.kt`
- Create: `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/InviteReader.kt`
- Create: `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/TapkartNfcPlugin.kt`
- Create: `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/MainActivity.kt`
- Test: `apps/android/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/LobbyAdvertTest.kt`
- Test: `apps/android/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/HceCompositionTest.kt`
- Test: `apps/android/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/NoApplicationRecordTest.kt`

**Ordering:** this task writes into the `apps/android` Capacitor project — `app/build.gradle.kts`, `app/src/main/kotlin/`, `app/src/test/kotlin/`. That project, its Gradle wrapper, its manifest and its version pins (§6.1, §6.6) are the **Android scaffold task's**, so run this after it. If `apps/android/gradlew` does not exist yet, that is the missing prerequisite and not a defect in this task.

Task 10 wrote the pure half — the tag, the NDEF encoder, the intent resolver — and proved it against the fixture in both languages. This task wires that half to the device: the HCE service Android calls when a guest's phone touches the host's, the reader that drives the same exchange from the other side, the Capacitor bridge the lobby talks to, and the activity that registers it.

**§0a's rule for this file group, and it is the whole design:** *"Adapter — the thin layer handing plain data to a real device API. No branching on game state, no arithmetic beyond unit conversion… A conditional in an adapter is a contract violation, because it is a decision CI cannot see."* Everything decidable is already decided in `T4tTag`, `NdefUri` and `InviteIntent`. `TapkartHceService` is six lines. That is not minimalism for its own sake — it is because **CI cannot execute a single line of this file group**, so every line in it is a line only code review and a phone can check.

**What CI proves about this task, exactly** (§12.2, §14):

| Proven | How |
|---|---|
| The bytes the service answers with | Task 10's fixture, replayed through the same composition the service performs — `HceCompositionTest` below |
| That the advert is never persisted (F-P5-45) | reflection over `LobbyAdvert`, below |
| That `LobbyAdvert.uri` is `@Volatile` | reflection, below — two threads touch it |
| That the NDEF message carries no Application Record (§7.5) | `NoApplicationRecordTest`, against the `ndef-uri.tsv` row for the golden URI |
| The service, reader-mode and preferred-service declarations | §12.2 assertions 22 and 23, over the merged manifest — a later task |

| **Not** proven, and named in §14 | Why |
|---|---|
| That the tap works | HCE needs two physical devices in antenna contact |
| That `FLAG_KEEP_SCREEN_ON` is set and cleared in pairs | §14: *"Physical… §6.4 rules 1 and 3 are code review only"* |
| That `InviteReader` drives a real `IsoDep` correctly | `IsoDep` is a final framework class; see the note below |
| That reader mode does not intercept a transit card | The OS decides |

**Why no test instantiates any of these classes.** Android's unit-test `android.jar` is a stub. §5.8 records what that means in this repository's own words — *"`org.json` is stubbed in Android JVM unit tests (`testOptions.unitTests.returnDefaultValues` either throws or silently returns zeros)"* — and the same is true of `HostApduService`, `NfcAdapter` and `IsoDep`. A unit test that constructs `TapkartHceService` either throws on a stub or, with `returnDefaultValues` on, passes while measuring nothing. **The second outcome is this project's signature defect**, so the tests below drive the *composition* the service performs, out of the pure classes, and the adapter itself is left to review and to §14.1's checklist. Saying that plainly is better than a green tick over a stub.

**Interfaces:**

- **Consumes** — Task 10's four pure classes, quoted:

  ```kotlin
  object Hex { fun encode(bytes: ByteArray): String; fun decode(s: String): ByteArray }

  object NdefUri {
      const val MAX_INVITE_URI_BYTES: Int = 250
      fun encodeUriRecord(uri: String): ByteArray     // throws on an unencodable URI
      fun buildNdefFile(uri: String?): ByteArray
      fun parseNdefFile(file: ByteArray): String?
  }

  class T4tTag {
      enum class Selected { NONE, APP, CC, NDEF }
      val selected: Selected
      fun setUri(uri: String?)
      fun reset()
      fun process(apdu: ByteArray): ByteArray         // NEVER throws
      companion object { val AID: ByteArray; val CC_FILE: ByteArray; const val MLE: Int; const val MLC: Int }
  }

  object InviteIntent {
      const val ACTION_VIEW: String = "android.intent.action.VIEW"
      const val ACTION_NDEF_DISCOVERED: String = "android.nfc.action.NDEF_DISCOVERED"
      fun uriFrom(action: String?, dataUri: String?): String?
  }
  ```

  Plus the platform and Capacitor APIs, whose exact shapes this task depends on:

  ```kotlin
  // android.nfc.cardemulation.HostApduService
  abstract fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray
  abstract fun onDeactivated(reason: Int)

  // android.nfc.NfcAdapter
  static fun getDefaultAdapter(context: Context): NfcAdapter?   // null on a device with no NFC
  fun enableReaderMode(activity: Activity, callback: ReaderCallback, flags: Int, extras: Bundle?)
  fun disableReaderMode(activity: Activity)
  val isEnabled: Boolean
  // flags used here: FLAG_READER_NFC_A, FLAG_READER_NFC_B,
  //                  FLAG_READER_SKIP_NDEF_CHECK, FLAG_READER_NO_PLATFORM_SOUNDS

  // android.nfc.cardemulation.CardEmulation
  static fun getInstance(adapter: NfcAdapter): CardEmulation
  fun setPreferredService(activity: Activity, service: ComponentName): Boolean
  fun unsetPreferredService(activity: Activity): Boolean

  // android.nfc.tech.IsoDep
  static fun get(tag: Tag): IsoDep?
  fun connect(); fun close(); fun transceive(data: ByteArray): ByteArray   // all throw IOException

  // com.getcapacitor — the plugin base class
  open class Plugin {
      fun getActivity(): AppCompatActivity
      fun notifyListeners(eventName: String, data: JSObject)
      protected open fun handleOnNewIntent(intent: Intent)
      protected open fun handleOnPause()
      protected open fun handleOnResume()
  }
  class JSObject { fun put(key: String, value: String?): JSObject; fun put(key: String, value: Boolean): JSObject }
  interface PluginCall { fun resolve(); fun resolve(data: JSObject); fun reject(message: String); fun getString(name: String): String? }
  open class BridgeActivity : AppCompatActivity { fun registerPlugin(plugin: Class<out Plugin>) }
  ```

  The Capacitor major, and therefore these shapes, are pinned once by the version-pin task (§6.6). **No task bumps a version to make its own step pass** (§0).

- **Produces** — contract §7.4, exactly the symbols below. §16's census fixes `nfc/LobbyAdvert` at 2, `nfc/TapkartHceService` at 3, `nfc/InviteReader` at 2, `TapkartNfcPlugin` at 10 and `MainActivity` at 1. Everything else is `private`.

  ```kotlin
  object LobbyAdvert { @Volatile var uri: String? }

  class TapkartHceService : HostApduService() {
      override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray
      override fun onDeactivated(reason: Int)
  }

  object InviteReader { fun read(isoDep: IsoDep): String? }

  @CapacitorPlugin(name = "TapkartNfc")
  class TapkartNfcPlugin : Plugin() {
      @PluginMethod fun isSupported(call: PluginCall)
      @PluginMethod fun startAdvertising(call: PluginCall)
      @PluginMethod fun stopAdvertising(call: PluginCall)
      @PluginMethod fun startReader(call: PluginCall)
      @PluginMethod fun stopReader(call: PluginCall)
      @PluginMethod fun getPendingInvite(call: PluginCall)
      override fun handleOnNewIntent(intent: Intent)
      override fun handleOnPause()
      override fun handleOnResume()
  }

  class MainActivity : BridgeActivity()
  ```

**The five behaviours §6.4 makes decisions rather than implementation detail**, each implemented below and each unverifiable in CI:

1. `startAdvertising` sets `FLAG_KEEP_SCREEN_ON`; `stopAdvertising` clears it. *"A host whose phone sleeps while the lobby is open has silently stopped being tappable, and no amount of correct APDU handling fixes it."*
2. `startAdvertising` calls `setPreferredService`; `stopAdvertising` calls `unsetPreferredService`. AID `D2760000850101` in category `other` can be claimed by more than one installed app, and this is the only defence against another app winning.
3. **The advert is cleared on pause** (F-P5-45), through the same path `stopAdvertising` uses, and **`LobbyAdvert` keeps no SharedPreferences persistence**: *"Restoring an advert across process death is precisely the backgrounded-host tap this ruling makes fail on purpose."* Tapping a backgrounded host is expected to fail — §14.1 item 10 confirms it deliberately.
4. Reader mode is on only while the guest is on a screen that can act on a tap, with `FLAG_READER_SKIP_NDEF_CHECK` so Android does not also fire its own dispatch for the tag we are reading. *"Always-on reader mode intercepts every transit card and hotel key the phone touches while the app is open."*
5. A tag read whose URI does not parse is dropped **silently** — and it is dropped in TypeScript, because §7.3 puts `parseInviteUri` in the WebView and runs it **once, for both entry points**. Kotlin emits the URI it read and decides nothing, which is what keeps F-P5-16's two entry points one path.

### §7.5 — no Android Application Record, and why the four bytes stay out

> The NDEF message contains a URI record and nothing else (P5 Q22). An AAR (`android.com:pkg`) would send a guest **without** the app to a Play Store page for an app that is not on the Play Store — and this game is distributed as a GitHub Release asset (spec §9) — which breaks exactly the row of spec §2's table that must work. App Links already routes the URL into the app when the app *is* installed; the AAR buys nothing and costs a dead end.

An AAR is not a flag one forgets to set; it is a **second NDEF record appended to the message**, so adding one changes the first record's ME bit, the record count, `NLEN` and every byte of the fixture. `NoApplicationRecordTest` below asserts exactly that shape against the published `ndef-uri.tsv` row, so the decision is a test rather than a comment.

---

- [ ] **Step 1: Write the failing test**

Create `apps/android/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/LobbyAdvertTest.kt`:

```kotlin
package io.github.atvriders.tapkart.nfc

import java.lang.reflect.Modifier
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * LobbyAdvert is the one adapter file with no android.* import, so it is the one
 * a JVM unit test can touch directly.
 *
 * JVM unit test: `./gradlew :app:testDebugUnitTest`.
 */
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
        // TapkartNfcPlugin writes it on the main thread; TapkartHceService reads
        // it on a binder thread when a guest's phone arrives. Without @Volatile
        // the service can serve a stale advert — or none — and the failure looks
        // exactly like a bad antenna.
        val field = LobbyAdvert::class.java.getDeclaredField("uri")
        assertTrue("LobbyAdvert.uri must be @Volatile", Modifier.isVolatile(field.modifiers))
    }

    @Test
    fun `nothing here persists the advert`() {
        // F-P5-45 and §6.4 rule 3: the draft's load(context)/store(context, ...)
        // and its PREFS_NAME/KEY_LOBBY_URI constants are REMOVED. Restoring an
        // advert across process death would resurrect exactly the
        // backgrounded-host tap the ruling makes fail on purpose.
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
```

Create `apps/android/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/HceCompositionTest.kt`:

```kotlin
package io.github.atvriders.tapkart.nfc

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * TapkartHceService is three lines of composition over T4tTag and LobbyAdvert,
 * and this class drives that composition with the golden exchange.
 *
 * It deliberately does NOT construct TapkartHceService: HostApduService comes
 * from the stub android.jar, where a constructor either throws or — with
 * testOptions.unitTests.returnDefaultValues — silently does nothing, and a test
 * that silently does nothing is worse than no test. What the service adds beyond
 * this composition is one super-class and one lifecycle callback, and those are
 * §14.1's owner checklist, items 5 to 10.
 *
 * JVM unit test: `./gradlew :app:testDebugUnitTest`.
 */
class HceCompositionTest {

    /** The rows of t4t-exchange.tsv this class proves, quoted from §5.7. */
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

    /** Exactly what TapkartHceService.processCommandApdu does, minus the framework. */
    private fun serve(tag: T4tTag, commandHex: String): String {
        tag.setUri(LobbyAdvert.uri)
        return Hex.encode(tag.process(Hex.decode(commandHex)))
    }

    @Test
    fun `an advertising host answers the golden exchange`() {
        // Fixture rows: selectApp (step 1), selectNdef (step 5), the NLEN read
        // (step 6) and the body read (step 7) of §5.7's table.
        LobbyAdvert.uri = goldenUri
        val tag = T4tTag()
        assertEquals("9000", serve(tag, selectApp))
        assertEquals("9000", serve(tag, selectNdef))
        assertEquals("001C9000", serve(tag, readNlen))
        assertEquals("${goldenRecord}9000", serve(tag, readBody))
    }

    @Test
    fun `a host that is not advertising is a well-formed empty tag`() {
        // §5.6 and the fixture's non-advertising rows: steps 1, 5 and 6 give
        // 9000, 9000, 0000 9000. A reader gets an empty tag and does nothing,
        // which is strictly better than a 6A82 some readers show as broken.
        LobbyAdvert.uri = null
        val tag = T4tTag()
        assertEquals("9000", serve(tag, selectApp))
        assertEquals("9000", serve(tag, selectNdef))
        assertEquals("00009000", serve(tag, readNlen))
    }

    @Test
    fun `clearing the advert mid-session stops serving the invite`() {
        // F-P5-45's path: handleOnPause sets LobbyAdvert.uri = null, and the very
        // next APDU serves the empty file. Nothing caches the old bytes.
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
        // §5.6: "an HCE service instance is reused across taps, so a state machine
        // that does not reset starts the second tap mid-conversation, and the
        // second guest of the evening gets nothing while the first got everything."
        // reset() is what TapkartHceService.onDeactivated must call.
        LobbyAdvert.uri = goldenUri
        val tag = T4tTag()
        assertEquals("9000", serve(tag, selectApp))
        assertEquals("9000", serve(tag, selectNdef))
        assertEquals("001C9000", serve(tag, readNlen))

        tag.reset() // ISO-DEP link lost: the first guest walked away.

        assertEquals("6986", serve(tag, readNlen)) // fixture row `readNlenEmpty`
        assertEquals("9000", serve(tag, selectApp))
        assertEquals("9000", serve(tag, selectNdef))
        assertEquals("001C9000", serve(tag, readNlen))
    }

    @Test
    fun `a null command APDU becomes a status word, not a crash`() {
        // processCommandApdu's parameter is nullable. The service maps null to an
        // empty array and lets the pure function answer 6700, so the adapter makes
        // no decision of its own and cannot throw inside a framework callback.
        val tag = T4tTag()
        assertEquals("6700", Hex.encode(tag.process(ByteArray(0))))
    }

    @Test
    fun `the fixture file backing these rows is present`() {
        // If someone moves the vectors, Task 10's runners fail loudly — this
        // asserts the same file is still reachable from this class too, so the
        // quoted rows above cannot quietly become fiction.
        assertNotNull(
            "fixture not on the test classpath: /t4t-exchange.tsv",
            javaClass.getResourceAsStream("/t4t-exchange.tsv"),
        )
    }
}
```

Create `apps/android/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/NoApplicationRecordTest.kt`:

```kotlin
package io.github.atvriders.tapkart.nfc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * §7.5, as a test rather than a comment. An Android Application Record is a
 * SECOND NDEF record appended to the message, so its absence is a statement
 * about bytes: one record, MB and ME both set, NLEN accounting for that record
 * and nothing after it.
 *
 * The bytes below are the ndef-uri.tsv row for the golden URI:
 *   https://tapkart.example/r/ABCDE
 *   001CD1011855047461706B6172742E6578616D706C652F722F4142434445
 *
 * JVM unit test: `./gradlew :app:testDebugUnitTest`.
 */
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
        // header + type length + payload length + type + payload == the whole message
        assertEquals(4 + payloadLength, nlen)
        assertEquals(2 + nlen, file.size)
    }

    @Test
    fun `the message contains no android application record`() {
        // An AAR is an external-type record whose type is the ASCII string
        // "android.com:pkg". If one is ever added, these bytes appear.
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./gradlew -p apps/android :app:testDebugUnitTest`

Expected: FAIL at Kotlin compilation, before any test runs:

```
e: file:///…/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/LobbyAdvertTest.kt:18:9 Unresolved reference: LobbyAdvert
e: file:///…/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/HceCompositionTest.kt:34:9 Unresolved reference: LobbyAdvert

> Task :app:compileDebugUnitTestKotlin FAILED
```

`NoApplicationRecordTest` compiles already (it uses only Task 10's classes) but is not reached, because a compilation failure in the source set fails the whole task.

**All three are JVM unit tests and run in CI.** This task writes no instrumented test: `TapkartHceService`, `TapkartNfcPlugin`, `InviteReader` and `MainActivity` need a device with an NFC antenna and a second phone to touch it, which `connectedDebugAndroidTest` cannot conjure on a runner. Their verification is §14.1's checklist, items 3 to 10.

- [ ] **Step 3: Write the implementation**

Create `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/LobbyAdvert.kt`:

```kotlin
package io.github.atvriders.tapkart.nfc

/**
 * ADAPTER — one process-global, and nothing else.
 *
 * Sole writer: TapkartNfcPlugin (§13). TapkartHceService reads it and never
 * writes it. NOT persisted anywhere: §6.4 rule 3 deleted the draft's
 * SharedPreferences load/store, because restoring an advert across process death
 * is precisely the backgrounded-host tap F-P5-45 makes fail on purpose.
 *
 * @Volatile because the plugin writes it on the main thread and the HCE service
 * reads it on a binder thread the moment a guest's phone arrives.
 */
object LobbyAdvert {
    @Volatile
    var uri: String? = null
}
```

Create `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/TapkartHceService.kt`:

```kotlin
package io.github.atvriders.tapkart.nfc

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * ADAPTER. Android hands us a command APDU; T4tTag decides everything.
 *
 * There is no branching here on purpose (§0a): a null command becomes an empty
 * array and the pure function answers 67 00, which is what the §5.5 table says
 * for an APDU shorter than four bytes.
 */
class TapkartHceService : HostApduService() {

    private val tag = T4tTag()

    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
        tag.setUri(LobbyAdvert.uri)
        return tag.process(commandApdu ?: ByteArray(0))
    }

    /**
     * ISO-DEP link lost. §5.6 and §13: this call is the single most likely
     * Kotlin-side bug in the plan — an HCE service instance is reused across
     * taps, and a state machine that does not reset here starts the second tap
     * mid-conversation, so the first guest of the evening gets everything and
     * the second gets nothing.
     */
    override fun onDeactivated(reason: Int) {
        tag.reset()
    }
}
```

Create `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/InviteReader.kt`:

```kotlin
package io.github.atvriders.tapkart.nfc

import android.nfc.tech.IsoDep
import java.io.IOException

/**
 * ADAPTER. The guest side of §5.2's exchange, driven over a real ISO-DEP link.
 *
 * This is the one piece of Kotlin no CI job can execute: IsoDep is a final
 * framework class over a radio. Its TypeScript twin, `readInvite` (§4.5), IS
 * proven — §12.2 assertion 4 drives it against `processApdu` through a loopback
 * Transceive — so this file is written to be a line-for-line reading of that
 * one, and it is reviewed against it rather than tested.
 *
 * It reads MLe out of the CC it just read, never out of T4tTag.MLE: "A reader
 * that trusts its own compiled-in value would work perfectly against our own tag
 * and fail against any other Type 4 tag" (§4.5).
 */
object InviteReader {

    private val SELECT_APP = byteArrayOf(
        0x00, 0xA4.toByte(), 0x04, 0x00, 0x07,
        0xD2.toByte(), 0x76, 0x00, 0x00, 0x85.toByte(), 0x01, 0x01, 0x00,
    )
    private val SELECT_CC = byteArrayOf(0x00, 0xA4.toByte(), 0x00, 0x0C, 0x02, 0xE1.toByte(), 0x03)
    private val SELECT_NDEF = byteArrayOf(0x00, 0xA4.toByte(), 0x00, 0x0C, 0x02, 0xE1.toByte(), 0x04)

    fun read(isoDep: IsoDep): String? {
        try {
            isoDep.connect()

            if (!isOk(isoDep.transceive(SELECT_APP))) return null
            if (!isOk(isoDep.transceive(SELECT_CC))) return null

            val cc = readBinary(isoDep, 0, 15) ?: return null
            if (cc.size < 15) return null
            // CC bytes 3..4 are MLe, big-endian (§5.3).
            val mle = ((cc[3].toInt() and 0xFF) shl 8) or (cc[4].toInt() and 0xFF)
            if (mle < 2) return null

            if (!isOk(isoDep.transceive(SELECT_NDEF))) return null

            val nlenBytes = readBinary(isoDep, 0, 2) ?: return null
            if (nlenBytes.size < 2) return null
            val nlen = ((nlenBytes[0].toInt() and 0xFF) shl 8) or (nlenBytes[1].toInt() and 0xFF)
            if (nlen == 0) return null

            val message = ByteArray(nlen)
            var read = 0
            while (read < nlen) {
                val want = minOf(mle, nlen - read)
                val chunk = readBinary(isoDep, 2 + read, want) ?: return null
                if (chunk.isEmpty()) return null
                chunk.copyInto(message, read)
                read += chunk.size
            }

            val file = ByteArray(2 + nlen)
            file[0] = nlenBytes[0]
            file[1] = nlenBytes[1]
            message.copyInto(file, 2)
            return NdefUri.parseNdefFile(file)
        } catch (e: IOException) {
            // A guest waves a phone past a host; a dropped link is the normal
            // case, not an error worth a modal (§6.4 rule 5).
            return null
        } catch (e: IllegalArgumentException) {
            // NdefUri.parseNdefFile throws on a malformed message, exactly as
            // uri.ts does, and readInvite turns that throw into null on the
            // TypeScript side (§4.5: "Never throws on a protocol error").
            // Someone else's tag is not an error; it is not our tag.
            return null
        } finally {
            try {
                isoDep.close()
            } catch (e: IOException) {
                // Nothing useful to do: the link is already gone.
            }
        }
    }

    private fun readBinary(isoDep: IsoDep, offset: Int, length: Int): ByteArray? {
        val command = byteArrayOf(
            0x00, 0xB0.toByte(),
            ((offset ushr 8) and 0xFF).toByte(), (offset and 0xFF).toByte(),
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
}
```

Create `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/TapkartNfcPlugin.kt`:

```kotlin
package io.github.atvriders.tapkart

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.nfc.NfcAdapter
import android.nfc.cardemulation.CardEmulation
import android.nfc.tech.IsoDep
import android.view.WindowManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import io.github.atvriders.tapkart.nfc.InviteIntent
import io.github.atvriders.tapkart.nfc.InviteReader
import io.github.atvriders.tapkart.nfc.LobbyAdvert
import io.github.atvriders.tapkart.nfc.NdefUri
import io.github.atvriders.tapkart.nfc.TapkartHceService

/**
 * ADAPTER — the Capacitor bridge. Everything decidable happens in the pure
 * classes or in the WebView; this file moves plain data across the boundary.
 */
@CapacitorPlugin(name = "TapkartNfc")
class TapkartNfcPlugin : Plugin() {

    private var readerEnabled = false
    private var pendingConsumed = false

    @PluginMethod
    fun isSupported(call: PluginCall) {
        val packageManager = activity.packageManager
        val adapter = NfcAdapter.getDefaultAdapter(activity)
        call.resolve(
            JSObject()
                .put("hardware", packageManager.hasSystemFeature(PackageManager.FEATURE_NFC))
                .put(
                    "hce",
                    packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION),
                )
                .put("adapterEnabled", adapter != null && adapter.isEnabled),
        )
    }

    @PluginMethod
    fun startAdvertising(call: PluginCall) {
        val uri = call.getString("uri")
        if (uri == null) {
            call.reject("uri is required")
            return
        }
        // The decision belongs to NdefUri, not to this file: if the record cannot
        // be built, the caller hears about it now rather than the radio serving
        // nothing later.
        try {
            NdefUri.encodeUriRecord(uri)
        } catch (e: IllegalArgumentException) {
            call.reject("uri cannot be encoded into an NDEF record: ${e.message}")
            return
        }
        val adapter = NfcAdapter.getDefaultAdapter(activity)
        if (adapter == null) {
            call.reject("this device has no NFC adapter")
            return
        }

        LobbyAdvert.uri = uri
        val current = activity
        current.runOnUiThread {
            // §6.4 rule 1: HCE does not answer with the screen off.
            current.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            // §6.4 rule 2: AID D2760000850101 in category `other` can be claimed
            // by more than one installed app, and this is the only defence.
            CardEmulation.getInstance(adapter)
                .setPreferredService(current, ComponentName(current, TapkartHceService::class.java))
        }
        call.resolve()
    }

    @PluginMethod
    fun stopAdvertising(call: PluginCall) {
        clearAdvert()
        call.resolve()
    }

    @PluginMethod
    fun startReader(call: PluginCall) {
        readerEnabled = true
        enableReaderMode()
        call.resolve()
    }

    @PluginMethod
    fun stopReader(call: PluginCall) {
        readerEnabled = false
        disableReaderMode()
        call.resolve()
    }

    /**
     * §7.4: a cold-start App Link is delivered to onCreate's intent BEFORE any
     * JavaScript has run, so no addListener can have been registered. Without
     * this, the very first tap into a not-yet-running app — the single most
     * likely real tap in the product — is silently dropped. Consumed once, so a
     * later reload does not re-join a dead room.
     */
    @PluginMethod
    fun getPendingInvite(call: PluginCall) {
        val intent = activity.intent
        val uri =
            if (pendingConsumed) null else InviteIntent.uriFrom(intent?.action, intent?.dataString)
        pendingConsumed = true
        // JSONObject.NULL, not a Kotlin null: JSObject.put(key, null) REMOVES the
        // key, so the WebView would see `undefined` where §4.6's pendingInvite()
        // promises `string | null`.
        call.resolve(JSObject().put("uri", uri ?: JSONObject.NULL))
    }

    /** Entry point 1 or 2, same URI, same event, one `source` field for the log. */
    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        val uri = InviteIntent.uriFrom(intent.action, intent.dataString) ?: return
        notifyListeners("inviteUri", JSObject().put("uri", uri).put("source", "appLink"))
    }

    /** F-P5-45 and P5 Q23 meet here: a paused app is neither reading nor readable. */
    override fun handleOnPause() {
        super.handleOnPause()
        disableReaderMode()
        clearAdvert()
    }

    override fun handleOnResume() {
        super.handleOnResume()
        if (readerEnabled) enableReaderMode()
    }

    private fun clearAdvert() {
        LobbyAdvert.uri = null
        val adapter = NfcAdapter.getDefaultAdapter(activity) ?: return
        val current = activity
        current.runOnUiThread {
            CardEmulation.getInstance(adapter).unsetPreferredService(current)
            current.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun enableReaderMode() {
        val adapter = NfcAdapter.getDefaultAdapter(activity) ?: return
        val flags =
            NfcAdapter.FLAG_READER_NFC_A or
                NfcAdapter.FLAG_READER_NFC_B or
                // Stops Android firing its own dispatch for the tag we are reading.
                NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or
                NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS
        adapter.enableReaderMode(
            activity,
            { tag ->
                val isoDep = IsoDep.get(tag)
                if (isoDep != null) {
                    val uri = InviteReader.read(isoDep)
                    // Kotlin decides nothing about the URI: parseInviteUri runs
                    // once, in the WebView, for both entry points (§7.3).
                    if (uri != null) {
                        notifyListeners(
                            "inviteUri",
                            JSObject().put("uri", uri).put("source", "tag"),
                        )
                    }
                }
            },
            flags,
            null,
        )
    }

    private fun disableReaderMode() {
        val adapter = NfcAdapter.getDefaultAdapter(activity) ?: return
        adapter.disableReaderMode(activity)
    }
}
```

Create `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/MainActivity.kt`:

```kotlin
package io.github.atvriders.tapkart

import android.os.Bundle
import com.getcapacitor.BridgeActivity

/**
 * ADAPTER. A local plugin is not auto-discovered the way an npm one is, so it is
 * registered here — before super.onCreate, which is when the bridge is built.
 */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TapkartNfcPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./gradlew -p apps/android :app:testDebugUnitTest`
Expected: all tests pass, including `nothing here persists the advert`, `the second tap of the evening works, because onDeactivated resets`, and `the message contains no android application record`.

Then prove the adapters actually compile against the framework and Capacitor, which the unit-test classpath does not fully cover:

Run: `./gradlew -p apps/android :app:assembleDebug`
Expected: BUILD SUCCESSFUL, an APK under `apps/android/app/build/outputs/apk/debug/`.

Then the Kotlin fixture runners from Task 10 must still be green, because this task added a second reader of the same vectors:

Run: `./gradlew -p apps/android :app:testDebugUnitTest --tests '*Vectors*'`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/android/app/src/main/kotlin apps/android/app/src/test/kotlin && git commit -m "feat(android): HCE service, reader, Capacitor bridge; no Application Record (F-P5-45, P5 Q22)"
```
