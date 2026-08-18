# Owner verification

**Repository status: not performed.** These checks remain for the owner on real
devices and the real deployment.

Everything in this file requires a person, a deployed HTTPS origin, or physical
hardware. CI does not prove any item below. Record the date, device model, OS
version, deployed origin, APK release tag, and result for every item before
calling a release verified.

Run the checklist after the first `v*` release and again whenever the deployed
origin, Android application ID, signing keystore, or NFC implementation changes.
Items 7 and 11 may be recorded as **not available** when the required hardware is
not available; do not record them as passed.

## Why this is separate from CI

On Android 12 and newer, a failed App Links verification is silent: an invite
opens in the browser instead of the app. The guest can still join because the QR
and room code remain available, so this failure can look like success unless the
tester watches which application opened.

CI does verify the parts that can be made deterministic:

- TypeScript and Kotlin replay the same NFC Type 4 Tag and NDEF byte fixtures.
- The reader/tag exchange, QR matrix, App Links document, manifest filters,
  application ID, and release certificate are checked mechanically.
- The built container must serve its generated Digital Asset Links statement as
  JSON with a direct `200` response.
- A real browser must reload offline and start a solo race from the precache.

Those checks cannot prove radio contact, Android's on-device domain verifier,
the owner's reverse proxy, a camera scan, audio quality, install-prompt
heuristics, or how the game feels on a phone.

## Before starting

You need the release APK attached to the GitHub Release, the deployed Tapkart
origin reachable over HTTPS, `adb`, `apksigner`, an NFC-capable Android host, and
at least one guest phone. Use the release APK, not a debug build. The examples
below use the repository's reserved host and canonical application ID; substitute
the origin you deployed without writing it into the repository.

## The 15-item checklist

1. **Install the release APK and confirm App Links verification.** Install the
   APK on the host phone, then run:

   ```bash
   adb shell pm get-app-links io.github.atvriders.tapkart
   ```

   Expect the deployed host to be `verified`. `legacy_failure`, `1024` (no
   response), `1025` (bad response), or any other non-verified result means the
   invite can open in a browser. Ask Android to retry after correcting the
   deployment:

   ```bash
   adb shell pm verify-app-links --re-verify io.github.atvriders.tapkart
   ```

2. **Verify the real HTTPS route and the installed certificate.** Request the
   statement through the public reverse proxy or tunnel, not through loopback:

   ```bash
   curl -I https://tapkart.example/.well-known/assetlinks.json
   curl --fail --silent --show-error https://tapkart.example/.well-known/assetlinks.json
   apksigner verify --print-certs app-release.apk
   ```

   Expect a direct `200`, `content-type: application/json`, and no `3xx`, even a
   same-URL trailing-slash redirect. Confirm `package_name` matches the installed
   APK and that `sha256_cert_fingerprints` contains the complete configured list,
   in order. Its first entry must equal the signer SHA-256 printed for this
   release APK.

3. **Host a lobby.** Confirm the tap prompt, QR code, and five-character room
   code are visible at the same time. A guest must never depend on NFC alone.

4. **Tap a guest without the app.** On Android 16 and earlier, expect the browser
   to open the lobby. On Android 17 and newer, expect a notification that opens
   it. Record the actual OS version and result.

5. **Tap a guest with the app in the foreground on its title screen.** Expect
   the guest to join the lobby in the app without opening a browser.

6. **Tap a guest with the app in the background.** Expect the verified App Link
   to route into the app, not the browser.

7. **Test an Android 15-or-earlier guest, if available.** This checks the second
   `NDEF_DISCOVERED` entry point. Record **not available** if no suitable device
   is available.

8. **Test a cold-start invite.** Fully stop the guest app, then tap. Expect the
   app to launch directly into the invited lobby rather than the title screen.
   This is the physical check for the pending-invite path that runs before
   JavaScript listeners exist.

9. **Lock the host screen and tap.** Expect nothing to happen. The HCE service
   requires an unlocked device; this is a documented limit, not a pass-through
   path.

10. **Background the host app and tap.** Expect nothing to happen. Tapkart
    deliberately clears its advert on pause, releases the preferred HCE service,
    and stops keeping the screen awake.

11. **Tap with an iPhone XS or newer, if available.** Record the device model,
    iOS version, and result. Background reading of an emulated tag varies by
    device and OS, so record data rather than treating one result as universal.

12. **Exercise both non-NFC join paths.** Scan the QR from a second phone at
    arm's length, then leave and join by typing the room code. Both paths must
    reach the same lobby and race.

13. **Test the installed PWA in airplane mode.** Complete one connected load so
    the service worker can precache the app, install it, enable airplane mode,
    reopen it, and start a solo race against bots. Multiplayer is intentionally
    unavailable offline.

14. **Listen and play on a phone.** Confirm engine pitch follows speed and that
    item, impact, boost, lap, countdown, and finish sounds fire at appropriate
    times. Also record whether controls, frame rate, orientation handling, and
    race readability feel acceptable on the tested device.

15. **Confirm two independent keystore backups exist.** Do this before pushing
    the first release tag. Neither backup may be in the checkout. A replacement
    signing key changes the certificate fingerprint and breaks verification for
    installed copies. See [Signing the Android app](../README.md#signing-the-android-app).

## If App Links are not verified

Check these independently; every one can fail without an in-app error:

- The host compiled into the release APK must be the deployed host. It comes
  from the release workflow's `TAPKART_ORIGIN` repository variable.
- `TAPKART_ANDROID_PACKAGE` must equal the APK's application ID.
- Every entry in `TAPKART_SHA256_FINGERPRINTS` must be a valid SHA-256
  certificate fingerprint, and the first must match the released APK's signer.
- `/.well-known/assetlinks.json` must be served directly by the deployed origin
  as JSON, with no redirect or proxy rewrite.
- After changing any of those inputs, rebuild/redeploy as appropriate and ask
  Android to re-verify before repeating items 4 through 8.
