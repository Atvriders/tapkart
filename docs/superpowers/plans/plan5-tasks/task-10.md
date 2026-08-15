### Task 10: `nfc/Hex.kt`, `nfc/NdefUri.kt`, `nfc/T4tTag.kt`, `nfc/InviteIntent.kt` — the Kotlin mirror, PURE

**Files:**
- Create: `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/Hex.kt`
- Create: `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/NdefUri.kt`
- Create: `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/T4tTag.kt`
- Create: `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/InviteIntent.kt`
- Modify: `apps/android/app/build.gradle.kts` — put the vector files on the unit-test classpath (§5.8)
- Test: `apps/android/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/T4tTagVectorsTest.kt`
- Test: `apps/android/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/NdefUriVectorsTest.kt`
- Test: `apps/android/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/InviteIntentTest.kt`

This is the second implementation of the tag. §5.1 says why it exists and what keeps it honest:

> This is **the one part of NFC that CI can genuinely test**. Two physical phones cannot meet in a GitHub Actions runner, but the bytes they would exchange are a pure function over byte arrays, and that function is implemented **twice** — once in TypeScript (`processApdu`) and once in Kotlin (`T4tTag.process`) — and both are driven from **one shared fixture** (§5.7).

**The mechanism is the fixture, and nothing else.** Two implementations of a byte protocol drift silently; the drift surfaces months later as *"the tap doesn't work on some phones"*. A Kotlin test that asserts Kotlin is self-consistent — that `process` returns what a Kotlin author expected — proves nothing about whether it agrees with the TypeScript, and it is precisely the shape of the twenty-one tests this project has shipped that could not detect what they existed to detect. So every test below replays `packages/invite/vectors/t4t-exchange.tsv` or `packages/invite/vectors/ndef-uri.tsv` — **the same files, byte for byte, that `packages/invite/test/vectors.test.ts` replays** — and each test below names the fixture rows it proves.

§5.8's rule about the failure mode of a vector runner applies to this side too, and it is a `@Test` here, not a comment:

> **Both suites must fail when the fixture file is missing or empty.** A vector runner that iterates zero rows and reports success is this project's signature defect, and it is the specific way this particular test would rot.

**What is mirrored and what is not** (§7.1): the NDEF encoder and the Type 4 tag state machine, and nothing else. No `parseInviteUri`, no `buildInviteUri`, no QR encoder — the WebView does that work in TypeScript, and everything not mirrored has exactly one implementation. That split is what keeps the two-language cost at one fixture.

**These four files are PURE** (§0a): no `android.*` import, no clock, no I/O. That is what lets them run in a **JVM unit test** with no device — which is the whole point, since a device is the thing CI does not have.

**Interfaces:**

- **Consumes** — the two fixture files, authored by the fixture task from contract §5.7 and §5.8, quoted here in full so the format is unambiguous:

  ```
  # t4t-exchange.tsv — version 1
  # NAME <TAB> NDEF_URI <TAB> RESET_BEFORE <TAB> COMMAND_HEX <TAB> RESPONSE_HEX <TAB> SELECTED_AFTER
  selectApp	https://tapkart.example/r/ABCDE	1	00A4040007D276000085010100	9000	app
  selectCc	.	0	00A4000C02E103	9000	cc
  readNlenEmpty	-	1	00B0000002	6986	none
  ```

  - `#` comments; uppercase unseparated hex; one exchange per line; applied **in file order** against one tag.
  - `NDEF_URI` — `.` leaves the tag as it is; `-` sets the empty file; anything else sets that URI.
  - `RESET_BEFORE` — `1` resets before the command, `0` does not. A `1` is what starts a new conversation.
  - `SELECTED_AFTER` — `none` | `app` | `cc` | `ndef`, compared after every line.

  ```
  # ndef-uri.tsv — URI <TAB> NDEF_FILE_HEX, with a line whose URI column is '-'
  # for the empty file 0000.
  https://tapkart.example/r/ABCDE	001CD1011855047461706B6172742E6578616D706C652F722F4142434445
  -	0000
  ```

  Both live in `packages/invite/vectors/`. §5.8 puts them on this module's unit-test classpath:

  > Gradle: the Android module adds
  > `sourceSets["test"].resources.srcDir("$rootDir/../../packages/invite/vectors")`
  > and the Kotlin test reads them off the test classpath. Repo-relative, no host path.

- **Produces** — contract §7.2 and §7.3, exactly the symbols below. §16's census fixes `nfc/Hex` at 3, `nfc/NdefUri` at 5, `nfc/T4tTag` at 10 and `nfc/InviteIntent` at 4; everything else in these files is `private`.

  ```kotlin
  package io.github.atvriders.tapkart.nfc

  object Hex {
      fun encode(bytes: ByteArray): String            // uppercase, unseparated
      fun decode(s: String): ByteArray                // tolerant of spaces and case
  }

  // NdefUri.kt — mirrors packages/invite/src/uri.ts exactly.
  object NdefUri {
      const val MAX_INVITE_URI_BYTES: Int = 250
      fun encodeUriRecord(uri: String): ByteArray
      fun buildNdefFile(uri: String?): ByteArray      // null -> byteArrayOf(0, 0)
      fun parseNdefFile(file: ByteArray): String?
  }

  // T4tTag.kt — mirrors packages/invite/src/t4t.ts exactly, including §5.4's order.
  class T4tTag {
      enum class Selected { NONE, APP, CC, NDEF }

      val selected: Selected                          // read-only to callers
      fun setUri(uri: String?)                        // sole writer of the NDEF file
      fun reset()                                     // sole writer of selected, besides process()
      fun process(apdu: ByteArray): ByteArray         // NEVER throws

      companion object {
          val AID: ByteArray                          // D2760000850101
          val CC_FILE: ByteArray                      // the 15 bytes of §5.3
          const val MLE: Int = 0x00F6
          const val MLC: Int = 0x00FF
      }
  }

  object InviteIntent {
      const val ACTION_VIEW: String = "android.intent.action.VIEW"
      const val ACTION_NDEF_DISCOVERED: String = "android.nfc.action.NDEF_DISCOVERED"
      fun uriFrom(action: String?, dataUri: String?): String?
  }
  ```

**The two Kotlin-specific traps, named before the code:**

1. **`ByteArray` is signed.** `apdu[0]` is a `Byte` in −128..127, so `apdu[0] == 0xD2` is a compile error and `apdu[0].toInt() == 0xD2` is silently `false` for every byte above 0x7F — which is every interesting byte in this protocol, starting with the AID's first one. Every read goes through `.toInt() and 0xFF`. TypeScript's `Uint8Array` has no such hazard, so this is a divergence the fixture exists to catch and the reason `selectApp` is the very first row.
2. **`reset()` on every deactivation.** §5.6: *"an HCE service instance is reused across taps, so a state machine that does not reset starts the second tap mid-conversation, and the second guest of the evening gets nothing while the first got everything… 'the first tap of the day works perfectly' is exactly the profile of a bug that ships."* `reset()` is written here; **calling** it from `onDeactivated` is Task 11's, and §13 makes it a sole-writer rule.

**What this task does not prove**, in §14's terms: nothing here happens over a radio. It proves the two implementations answer every command in the §5.7 table identically, including the error cases. The tap itself is §14.1's owner checklist, items 4 through 10.

---

- [ ] **Step 1: Write the failing test**

First put the vectors on the unit-test classpath. In `apps/android/app/build.gradle.kts`, inside the existing `android { }` block:

```kotlin
    // §5.8: BOTH suites replay the same two files. Repo-relative, never a host
    // path. If the P5 Q9 layout branch put the Gradle root somewhere else, this
    // relative path shifts with it — and the tests below fail loudly rather
    // than silently iterating zero rows.
    sourceSets["test"].resources.srcDir("$rootDir/../../packages/invite/vectors")
```

The Kotlin Android plugin already registers `src/main/kotlin` and `src/test/kotlin` as source directories, and the Capacitor template already declares `testImplementation` on JUnit 4 through its own version variable — **do not add or bump either** (§0: every third-party version is pinned once, by the version-pin task).

Create `apps/android/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/T4tTagVectorsTest.kt`:

```kotlin
package io.github.atvriders.tapkart.nfc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Contract §5.7 and §5.8. This class replays the SAME file
 * packages/invite/test/vectors.test.ts replays, line for line, so that
 * "the two implementations agree" is a measurement and not a claim.
 *
 * JVM unit test: runs on every CI push via `./gradlew :app:testDebugUnitTest`.
 * No device, no emulator, no android.* import anywhere in the classes it drives.
 */
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
        // §5.8: a missing fixture must FAIL. A vector runner that cannot find its
        // vectors and reports success is the defect this whole file exists against.
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

    private val rows: List<Row> = readRows("/t4t-exchange.tsv")

    @Test
    fun `the fixture is not empty`() {
        // §5.8, stated as a test in both languages.
        assertTrue("t4t-exchange.tsv yielded no rows", rows.isNotEmpty())
    }

    @Test
    fun `every row of t4t-exchange tsv replays identically`() {
        val tag = T4tTag()
        for (row in rows) {
            when (row.ndefUri) {
                "." -> Unit
                "-" -> tag.setUri(null)
                else -> tag.setUri(row.ndefUri)
            }
            if (row.resetBefore == "1") tag.reset()

            val response = tag.process(Hex.decode(row.commandHex))
            assertEquals(
                "line ${row.lineNumber} (${row.name}): response for ${row.commandHex}",
                row.responseHex,
                Hex.encode(response),
            )
            assertEquals(
                "line ${row.lineNumber} (${row.name}): selected after ${row.commandHex}",
                row.selectedAfter.uppercase(),
                tag.selected.name,
            )
        }
    }

    @Test
    fun `the fixture covers the happy path, the empty tag and the error table`() {
        // Guards against a fixture that has been quietly shortened: the rows that
        // matter most are the ones a "simplification" would delete first.
        val commands = rows.map { it.commandHex }.toSet()
        val responses = rows.map { it.responseHex }.toSet()
        // §5.7 steps 1-7, the happy path a real Android reader performs.
        assertTrue("no SELECT application row", commands.contains("00A4040007D276000085010100"))
        assertTrue("no SELECT CC row", commands.contains("00A4000C02E103"))
        assertTrue("no SELECT NDEF row", commands.contains("00A4000C02E104"))
        assertTrue("no READ BINARY row", commands.contains("00B0000002"))
        // §5.5's error table, every status word.
        for (sw in listOf("6700", "6985", "6986", "6A82", "6A86", "6B00", "6D00", "6E00")) {
            assertTrue("no row produces $sw", responses.any { it.endsWith(sw) })
        }
    }

    @Test
    fun `the second tap of the evening starts from none`() {
        // §5.6 and the fixture's `readNlenEmpty` row: after reset(), a READ BINARY
        // is 6986 because nothing is selected. This is the bug whose profile is
        // "the first tap of the day works perfectly".
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
    fun `process never throws, whatever arrives`() {
        // §4.4: "NEVER THROWS: every malformed input maps to a status word."
        // A throw inside processCommandApdu is a dead tag on a real phone.
        val tag = T4tTag()
        tag.setUri("https://tapkart.example/r/ABCDE")
        val hostile = listOf(
            "", "00", "00A4", "00A404", "FFFFFFFFFF", "00B000FF00", "00A4040000",
            "00A4040007D2760000850101", "00A404000700000000000000", "00B0000000",
            "00A4040100", "00C0000000", "80B0000002", "00A4040007D27600008501",
        )
        for (hex in hostile) {
            val response = tag.process(Hex.decode(hex))
            assertTrue("$hex produced a response shorter than a status word", response.size >= 2)
        }
    }

    @Test
    fun `CC_FILE is the fifteen bytes of contract section 5 point 3`() {
        assertEquals("000F2000F600FF0406E104040000FF", Hex.encode(T4tTag.CC_FILE))
        assertEquals(15, T4tTag.CC_FILE.size)
        assertEquals("D2760000850101", Hex.encode(T4tTag.AID))
        assertEquals(0x00F6, T4tTag.MLE)
        assertEquals(0x00FF, T4tTag.MLC)
    }

    @Test
    fun `an over-read is truncated, not rejected`() {
        // The fixture's `00B0001C40` row, restated so nobody "fixes" it to 6C02:
        // offset 28 is inside the 30-byte file and Le is 64, so the tag returns
        // the final two bytes and 9000.
        val tag = T4tTag()
        tag.setUri("https://tapkart.example/r/ABCDE")
        tag.process(Hex.decode("00A4040007D276000085010100"))
        tag.process(Hex.decode("00A4000C02E104"))
        assertEquals("44459000", Hex.encode(tag.process(Hex.decode("00B0001C40"))))
    }
}
```

Create `apps/android/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/NdefUriVectorsTest.kt`:

```kotlin
package io.github.atvriders.tapkart.nfc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Contract §5.8's second fixture, replayed in both languages: the TypeScript
 * side is packages/invite/test/vectors.test.ts, and it reads this same file.
 *
 * JVM unit test: `./gradlew :app:testDebugUnitTest`.
 */
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
    fun `every row round-trips back to its URI`() {
        for (row in rows) {
            assertEquals(
                "line ${row.lineNumber}: parseNdefFile(${row.fileHex})",
                row.uri,
                NdefUri.parseNdefFile(Hex.decode(row.fileHex)),
            )
        }
    }

    @Test
    fun `the fixture carries the empty file and the golden invite`() {
        assertTrue("no empty-file row", rows.any { it.uri == null && it.fileHex == "0000" })
        assertTrue(
            "no https row",
            rows.any { it.uri != null && it.uri.startsWith("https://") },
        )
    }

    @Test
    fun `the empty file is exactly two zero bytes`() {
        // §5.6: TagState's NDEF file is ALWAYS a valid file. A reader that taps a
        // non-advertising host gets a well-formed empty tag and does nothing —
        // strictly better than a 6A82 some readers surface as a broken tag.
        assertEquals("0000", Hex.encode(NdefUri.buildNdefFile(null)))
        assertNull(NdefUri.parseNdefFile(Hex.decode("0000")))
    }

    @Test
    fun `the golden record abbreviates https and nothing else`() {
        // §5.7, byte by byte: D1 01 18 55 04 then 23 ASCII bytes.
        val record = NdefUri.encodeUriRecord("https://tapkart.example/r/ABCDE")
        assertEquals(
            "D1011855047461706B6172742E6578616D706C652F722F4142434445",
            Hex.encode(record),
        )
        // §7.5: no Android Application Record. One record, so MB and ME are both
        // set in the first byte — 0xD1 — and there is no second record after it.
        assertEquals(28, record.size)
    }

    @Test
    fun `length is measured in UTF-8 bytes, not characters`() {
        // §4.2: "The URI is encoded as UTF-8 and the length checks are in bytes,
        // not characters, in both languages."
        //
        // 130 'é' after the abbreviated scheme is 138 CHARACTERS — under every
        // limit in this file — and 261 payload BYTES, which is over the one-byte
        // payload-length field. A character-counting encoder accepts this and
        // emits a record whose declared length is 261 mod 256 = 5.
        val overLong = "https://" + "é".repeat(130)
        assertTrue("the trap only works if this is short in characters", overLong.length < 250)
        var threw = false
        try {
            NdefUri.encodeUriRecord(overLong)
        } catch (e: IllegalArgumentException) {
            threw = true
        }
        assertTrue("an over-long URI must throw at the call site, not on the radio", threw)

        // And the published margin constant is what it says it is.
        assertEquals(250, NdefUri.MAX_INVITE_URI_BYTES)
    }

    @Test
    fun `a file that is not a single well-known U record parses to null`() {
        // parseNdefFile returns null rather than throwing on anything a radio
        // could hand it; only a caller's own over-long URI throws.
        assertNull(NdefUri.parseNdefFile(Hex.decode("0000")))
        assertNull(NdefUri.parseNdefFile(ByteArray(0)))
        assertNull(NdefUri.parseNdefFile(Hex.decode("00")))
        assertNull(NdefUri.parseNdefFile(Hex.decode("0004D1010055")))
        assertNull(NdefUri.parseNdefFile(Hex.decode("00FFD101185504")))
    }
}
```

Create `apps/android/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/InviteIntentTest.kt`:

```kotlin
package io.github.atvriders.tapkart.nfc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * F-P5-16, discharged: "both filters deliver the same URI to the same handler…
 * It is one path with two entry points, and a test asserts both intents resolve
 * identically."
 *
 * There is no fixture row for this one and this file does not pretend there is:
 * the two fixtures cover T4tTag and NdefUri. What is proven here is the identity
 * over a table of URIs, which is exactly what the ruling asks for.
 *
 * JVM unit test: `./gradlew :app:testDebugUnitTest`.
 */
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
                "the two intent actions disagreed for ${uri ?: "null"}",
                InviteIntent.uriFrom(InviteIntent.ACTION_VIEW, uri),
                InviteIntent.uriFrom(InviteIntent.ACTION_NDEF_DISCOVERED, uri),
            )
        }
    }

    @Test
    fun `a usable URI comes back unchanged`() {
        // §7.3: "returns dataUri unchanged when it is non-null and non-blank. It
        // does NOT parse the invite — parseInviteUri is TypeScript's and runs
        // once, in the WebView, for both entry points."
        for (uri in uris.filterNotNull().filter { it.isNotBlank() }) {
            assertEquals(uri, InviteIntent.uriFrom(InviteIntent.ACTION_VIEW, uri))
            assertEquals(uri, InviteIntent.uriFrom(InviteIntent.ACTION_NDEF_DISCOVERED, uri))
        }
    }

    @Test
    fun `null, empty and blank are all null`() {
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
        assertNull(InviteIntent.uriFrom(null, uri))
        assertNull(InviteIntent.uriFrom("", uri))
        assertNull(InviteIntent.uriFrom("android.intent.action.MAIN", uri))
        assertNull(InviteIntent.uriFrom("android.nfc.action.TECH_DISCOVERED", uri))
        assertNull(InviteIntent.uriFrom("android.nfc.action.TAG_DISCOVERED", uri))
        assertNull(InviteIntent.uriFrom("ACTION_VIEW", uri))
    }

    @Test
    fun `the action names are the platform's, spelled exactly`() {
        // These are string literals rather than Intent.ACTION_VIEW and
        // NfcAdapter.ACTION_NDEF_DISCOVERED so that this file stays PURE and runs
        // with no framework on the classpath. The manifest declares the same two
        // names (§6.2), and §12.2's assertions 19 and 20 check that side; a typo
        // in either half is a filter that never fires and a tap that does nothing.
        assertEquals("android.intent.action.VIEW", InviteIntent.ACTION_VIEW)
        assertEquals("android.nfc.action.NDEF_DISCOVERED", InviteIntent.ACTION_NDEF_DISCOVERED)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run, from the repository root: `./gradlew -p apps/android :app:testDebugUnitTest`
(equivalently `cd apps/android && ./gradlew :app:testDebugUnitTest`). This needs the Android SDK; in CI it is the `android` job, which has it.

Expected: FAIL at Kotlin compilation, before any test runs:

```
e: file:///…/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/T4tTagVectorsTest.kt:46:19 Unresolved reference: T4tTag
e: file:///…/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/T4tTagVectorsTest.kt:55:29 Unresolved reference: Hex
e: file:///…/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/NdefUriVectorsTest.kt:41:23 Unresolved reference: NdefUri
e: file:///…/app/src/test/kotlin/io/github/atvriders/tapkart/nfc/InviteIntentTest.kt:32:13 Unresolved reference: InviteIntent

> Task :app:compileDebugUnitTestKotlin FAILED
```

**These are JVM unit tests.** They run on every CI push. This task writes **no instrumented test** (`src/androidTest`, `connectedDebugAndroidTest`): an instrumented test needs a device or emulator, CI has neither, and a test lane that never runs is worse than no lane at all.

- [ ] **Step 3: Write the implementation**

Create `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/Hex.kt`:

```kotlin
package io.github.atvriders.tapkart.nfc

/**
 * PURE. Mirrors packages/invite/src/hex.ts.
 *
 * One spelling of hex in this repository: uppercase, unseparated (§0), so that a
 * string compare is a byte compare and the fixture can be read by eye.
 */
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

    /** Accepts uppercase, lowercase and embedded whitespace; throws on odd
     *  length or a non-hex character. Used by fixtures and by nothing shipped. */
    fun decode(s: String): ByteArray {
        val cleaned = s.filterNot { it.isWhitespace() }
        require(cleaned.length % 2 == 0) { "hex string has an odd length: ${cleaned.length}" }
        val out = ByteArray(cleaned.length / 2)
        for (i in out.indices) {
            out[i] = ((digit(cleaned[i * 2]) shl 4) or digit(cleaned[i * 2 + 1])).toByte()
        }
        return out
    }

    // Explicit ranges rather than Character.digit, which also accepts Unicode
    // decimal digits from other scripts — an acceptance the TypeScript does not
    // have and that no fixture would ever reveal.
    private fun digit(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> throw IllegalArgumentException("not a hex character: '$c'")
    }
}
```

Create `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/NdefUri.kt`:

```kotlin
package io.github.atvriders.tapkart.nfc

/**
 * PURE. Mirrors packages/invite/src/uri.ts exactly, including its byte order:
 * NDEF is big-endian (§0), which is the opposite of Plan 2's wire rule and is
 * not ours to choose.
 */
object NdefUri {

    /** A short NDEF record's payload length field is one byte. 250 leaves margin
     *  under 255 for the 'https://' abbreviation and the room code. */
    const val MAX_INVITE_URI_BYTES: Int = 250

    /** NFC Forum URI Record Type Definition abbreviation table, index 0x00..0x23.
     *  The same table uri.ts exports as NDEF_URI_PREFIXES; private here because
     *  §16 fixes this object at five exported symbols. Index 0x04 is 'https://'
     *  and is the only one this game ever emits — the rest exist so that reading
     *  a foreign tag behaves the same in both languages. */
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

    /** Single well-known URI record: MB=1 ME=1 CF=0 SR=1 IL=0 TNF=001 -> 0xD1,
     *  type 'U' (0x55), payload = [prefixCode, ...rest]. Throws if the encoded
     *  payload would exceed 255 bytes. Emits NO Android Application Record (§7.5). */
    fun encodeUriRecord(uri: String): ByteArray {
        // The ONLY gate here is §4.2's: "Throws if the encoded payload would
        // exceed 255 bytes." MAX_INVITE_URI_BYTES is the published margin, not a
        // second gate — a gate that exists in one language and not the other is
        // a divergence no fixture row would ever reveal, because every URI this
        // game builds is capped at 208 bytes by MAX_INVITE_ORIGIN_BYTES (§4.3).
        // Longest matching abbreviation, so 'https://www.x' takes 0x02 and not 0x04.
        var prefixCode = 0
        var prefixLength = 0
        for (i in 1 until PREFIXES.size) {
            val p = PREFIXES[i]
            if (uri.startsWith(p) && p.length > prefixLength) {
                prefixCode = i
                prefixLength = p.length
            }
        }
        val rest = uri.substring(prefixLength).toByteArray(Charsets.UTF_8)
        val payloadLength = 1 + rest.size
        require(payloadLength <= 255) { "NDEF payload would exceed 255 bytes: $payloadLength" }

        val record = ByteArray(4 + payloadLength)
        record[0] = 0xD1.toByte()
        record[1] = 0x01
        record[2] = payloadLength.toByte()
        record[3] = 0x55
        record[4] = prefixCode.toByte()
        rest.copyInto(record, 5)
        return record
    }

    /** NLEN (u16 big-endian) followed by the message. `null` yields exactly
     *  byteArrayOf(0, 0) — a valid, empty, readable tag (§5.6). */
    fun buildNdefFile(uri: String?): ByteArray {
        if (uri == null) return byteArrayOf(0, 0)
        val record = encodeUriRecord(uri)
        val file = ByteArray(2 + record.size)
        file[0] = ((record.size ushr 8) and 0xFF).toByte()
        file[1] = (record.size and 0xFF).toByte()
        record.copyInto(file, 2)
        return file
    }

    /** Inverse. Returns null for NLEN == 0, and for anything that is not a single
     *  well-known 'U' record — these bytes come off a radio, so nothing here
     *  throws. */
    fun parseNdefFile(file: ByteArray): String? {
        if (file.size < 2) return null
        val nlen = ((file[0].toInt() and 0xFF) shl 8) or (file[1].toInt() and 0xFF)
        if (nlen == 0) return null
        if (nlen + 2 > file.size) return null
        if (nlen < 5) return null

        val header = file[2].toInt() and 0xFF
        // MB=1, ME=1, CF=0, SR=1, IL=0, TNF=001.
        if (header != 0xD1) return null
        val typeLength = file[3].toInt() and 0xFF
        val payloadLength = file[4].toInt() and 0xFF
        if (typeLength != 1) return null
        if ((file[5].toInt() and 0xFF) != 0x55) return null
        if (4 + typeLength + payloadLength != nlen) return null
        if (payloadLength < 1) return null

        val prefixCode = file[6].toInt() and 0xFF
        if (prefixCode >= PREFIXES.size) return null
        val rest = file.copyOfRange(7, 7 + payloadLength - 1)
        return PREFIXES[prefixCode] + String(rest, Charsets.UTF_8)
    }
}
```

Create `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/T4tTag.kt`:

```kotlin
package io.github.atvriders.tapkart.nfc

/**
 * PURE. Mirrors packages/invite/src/t4t.ts exactly, including the ORDER of
 * §5.4's checks — because two implementations that check the same conditions in
 * different orders return different status words for an APDU that violates two
 * of them at once, and the fixture would then fail with no bug present.
 *
 * ISO 7816 is big-endian (§0). ByteArray is signed, so every byte is read
 * through `.toInt() and 0xFF`; without that, every comparison against a value
 * above 0x7F is silently false, starting with the AID's first byte.
 */
class T4tTag {

    enum class Selected { NONE, APP, CC, NDEF }

    var selected: Selected = Selected.NONE
        private set

    /** NLEN + message; 0x00,0x00 when not advertising. Always a valid file (§5.6).
     *  Sole writer: setUri (§13). */
    private var ndefFile: ByteArray = byteArrayOf(0, 0)

    /** Sole writer of the NDEF file. `null` -> the empty file. Throws exactly
     *  where buildNdefFile throws, so an over-long URI fails at the call site
     *  rather than on the radio. Does NOT change `selected`. */
    fun setUri(uri: String?) {
        ndefFile = NdefUri.buildNdefFile(uri)
    }

    /** ISO-DEP link lost. MUST be called from HostApduService.onDeactivated —
     *  see §5.6: an HCE service instance is reused across taps, so a state
     *  machine that does not reset starts the second tap mid-conversation. */
    fun reset() {
        selected = Selected.NONE
    }

    /** The whole tag, as a pure function. Returns response data followed by the
     *  two status-word bytes. NEVER THROWS: every malformed input maps to a
     *  status word in the §5.5 table. */
    fun process(apdu: ByteArray): ByteArray {
        // 1
        if (apdu.size < 4) return sw(SW_WRONG_LENGTH)
        val cla = apdu[0].toInt() and 0xFF
        val ins = apdu[1].toInt() and 0xFF
        val p1 = apdu[2].toInt() and 0xFF
        val p2 = apdu[3].toInt() and 0xFF
        // 2
        if (cla != 0x00) return sw(SW_CLA_NOT_SUPPORTED)
        // 3
        if (ins != INS_SELECT && ins != INS_READ_BINARY) return sw(SW_INS_NOT_SUPPORTED)

        // 4 — the length triple. lc == 0 with dataOffset == 0 means "no data".
        var lc = 0
        var dataOffset = 0
        var le = -1
        val b4 = if (apdu.size > 4) apdu[4].toInt() and 0xFF else 0
        when {
            apdu.size == 4 -> Unit                                   // case 1
            apdu.size == 5 -> le = if (b4 == 0) 256 else b4           // case 2
            b4 == 0 -> return sw(SW_WRONG_LENGTH)                     // extended length
            apdu.size == 5 + b4 -> {                                  // case 3
                lc = b4
                dataOffset = 5
            }
            apdu.size == 6 + b4 -> {                                  // case 4
                lc = b4
                dataOffset = 5
                val trailing = apdu[5 + b4].toInt() and 0xFF
                le = if (trailing == 0) 256 else trailing
            }
            else -> return sw(SW_WRONG_LENGTH)
        }

        // 5 — SELECT
        if (ins == INS_SELECT) {
            val p1p2 = (p1 shl 8) or p2
            if (p1p2 == 0x0400) {
                if (dataOffset == 0 || lc != AID.size) return sw(SW_FILE_NOT_FOUND)
                for (i in AID.indices) {
                    if (apdu[dataOffset + i] != AID[i]) return sw(SW_FILE_NOT_FOUND)
                }
                selected = Selected.APP
                return sw(SW_OK)
            }
            if (p1p2 == 0x000C) {
                if (selected == Selected.NONE) return sw(SW_CONDITIONS_NOT_SATISFIED)
                if (dataOffset == 0 || lc != 2) return sw(SW_FILE_NOT_FOUND)
                val fileId =
                    ((apdu[dataOffset].toInt() and 0xFF) shl 8) or (apdu[dataOffset + 1].toInt() and 0xFF)
                when (fileId) {
                    CC_FILE_ID -> selected = Selected.CC
                    NDEF_FILE_ID -> selected = Selected.NDEF
                    else -> return sw(SW_FILE_NOT_FOUND)
                }
                return sw(SW_OK)
            }
            return sw(SW_INCORRECT_P1P2)
        }

        // 6 — READ BINARY. Case 2 only: a bare Le, no data.
        if (apdu.size != 5) return sw(SW_WRONG_LENGTH)
        if (selected == Selected.NONE || selected == Selected.APP) return sw(SW_COMMAND_NOT_ALLOWED)
        val file = if (selected == Selected.CC) CC_FILE else ndefFile
        val offset = (p1 shl 8) or p2
        if (offset >= file.size) return sw(SW_WRONG_PARAMETERS)
        // Reaching here means case 2, so `le` is set; 0x00 already became 256.
        val n = minOf(le, MLE, file.size - offset)
        val out = ByteArray(n + 2)
        file.copyInto(out, 0, offset, offset + n)
        out[n] = ((SW_OK ushr 8) and 0xFF).toByte()
        out[n + 1] = (SW_OK and 0xFF).toByte()
        return out
    }

    private fun sw(status: Int): ByteArray =
        byteArrayOf(((status ushr 8) and 0xFF).toByte(), (status and 0xFF).toByte())

    companion object {
        /** NDEF Type 4 Tag application, NFC Forum registered. */
        val AID: ByteArray = byteArrayOf(
            0xD2.toByte(), 0x76, 0x00, 0x00, 0x85.toByte(), 0x01, 0x01,
        )

        /** The 15-byte Capability Container of §5.3, frozen. Write access is
         *  denied permanently and by design: a writable emulated tag is a way
         *  for a stranger's phone to change what the host is advertising. */
        val CC_FILE: ByteArray = byteArrayOf(
            0x00, 0x0F,                     // CCLEN = 15
            0x20,                           // mapping version 2.0
            0x00, 0xF6.toByte(),            // MLe = 246
            0x00, 0xFF.toByte(),            // MLc = 255
            0x04,                           // NDEF File Control TLV, tag
            0x06,                           // NDEF File Control TLV, length
            0xE1.toByte(), 0x04,            // NDEF file identifier
            0x04, 0x00,                     // maximum NDEF file size = 1024
            0x00,                           // read access: granted
            0xFF.toByte(),                  // write access: denied
        )

        const val MLE: Int = 0x00F6
        const val MLC: Int = 0x00FF

        private const val CC_FILE_ID = 0xE103
        private const val NDEF_FILE_ID = 0xE104
        private const val INS_SELECT = 0xA4
        private const val INS_READ_BINARY = 0xB0

        private const val SW_OK = 0x9000
        private const val SW_WRONG_LENGTH = 0x6700
        private const val SW_CONDITIONS_NOT_SATISFIED = 0x6985
        private const val SW_COMMAND_NOT_ALLOWED = 0x6986
        private const val SW_WRONG_PARAMETERS = 0x6B00
        private const val SW_FILE_NOT_FOUND = 0x6A82
        private const val SW_INCORRECT_P1P2 = 0x6A86
        private const val SW_INS_NOT_SUPPORTED = 0x6D00
        private const val SW_CLA_NOT_SUPPORTED = 0x6E00
    }
}
```

Create `apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc/InviteIntent.kt`:

```kotlin
package io.github.atvriders.tapkart.nfc

/**
 * PURE. The whole of F-P5-16's "one path, two entry points", as a pure function,
 * so that "both intents resolve identically" is a unit test and not a claim.
 *
 * The action names are string literals rather than Intent.ACTION_VIEW and
 * NfcAdapter.ACTION_NDEF_DISCOVERED so this file imports nothing from android.*
 * and runs in a JVM unit test with no framework on the classpath.
 */
object InviteIntent {

    const val ACTION_VIEW: String = "android.intent.action.VIEW"
    const val ACTION_NDEF_DISCOVERED: String = "android.nfc.action.NDEF_DISCOVERED"

    /** The URI to hand to the web layer, or null. Accepts exactly the two actions
     *  above and nothing else; returns `dataUri` unchanged when it is non-null and
     *  non-blank. It does NOT parse the invite — parseInviteUri is TypeScript's
     *  and runs once, in the WebView, for both entry points. */
    fun uriFrom(action: String?, dataUri: String?): String? {
        if (action != ACTION_VIEW && action != ACTION_NDEF_DISCOVERED) return null
        if (dataUri == null || dataUri.isBlank()) return null
        return dataUri
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./gradlew -p apps/android :app:testDebugUnitTest`
Expected: all tests pass. The report is at `apps/android/app/build/reports/tests/testDebugUnitTest/index.html`.

Then prove the fixture is actually being read, because a green run over zero rows is the failure this task is written against:

Run: `./gradlew -p apps/android :app:testDebugUnitTest --tests '*T4tTagVectorsTest*' --info | grep -c 't4t-exchange'`
Expected: the run is green **and** `the fixture is not empty` appears as a passing test; if the resource were missing, `assertNotNull` fails with `fixture not on the test classpath: /t4t-exchange.tsv`.

Then confirm the TypeScript side still replays the same file unchanged — the two suites must never diverge on the fixture:

Run: `npm test`
Expected: pass, including `packages/invite/test/vectors.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/android/app/src/main/kotlin/io/github/atvriders/tapkart/nfc apps/android/app/src/test/kotlin/io/github/atvriders/tapkart/nfc apps/android/app/build.gradle.kts && git commit -m "feat(android): Kotlin mirror of the Type 4 tag, driven by the shared fixture"
```
