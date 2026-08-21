# Owner verification

**Repository status: not performed.** These checks remain for the owner on real
devices and the real deployment.

Everything in this file requires a person, a deployed HTTPS origin, or physical
hardware. CI does not prove any item below. Record the date, device model, OS
version, deployed origin, APK release tag, and result for every item before
calling a release verified.

Run the checklist after the first `v*` release and again whenever the deployed
origin, Android application ID, signing keystore, NFC implementation, control
layout, safe-area handling, or system-bar configuration changes. Items 7, 11, and
19 through 24 may be recorded as **not available** when the required hardware is
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
- The responsive control layout is asserted against hand-written rectangles at
  eight viewports, from a 360 × 640 phone to a 1366 × 1024 tablet, together with
  the invariants that no control overlaps another and that every control stays
  on screen; a real browser then drives both a portrait and a landscape viewport
  end to end.

Those checks cannot prove radio contact, Android's on-device domain verifier,
the owner's reverse proxy, a camera scan, audio quality, install-prompt
heuristics, or how the game feels on a phone.

The same gap opens around anything drawn on a screen. This checkout has no
Android device, no emulator, no foldable, no tablet, no device with a display
cutout, no iPhone, no real WebGL context in CI, and no HTTPS lane for the browser
tests. Arithmetic about a layout is testable; a status bar that will not stay
hidden, a fold that drops a live race, a cutout that swallows a button, and a
thumb that cannot reach the drift button are not. Items 16 through 29 exist for
exactly that.

## Before starting

You need the release APK attached to the GitHub Release, the deployed Tapkart
origin reachable over HTTPS, `adb`, `apksigner`, an NFC-capable Android host, and
at least one guest phone. Use the release APK, not a debug build. The examples
below use the repository's reserved host and canonical application ID; substitute
the origin you deployed without writing it into the repository.

Items 16 through 29 want more hardware than the invite checks do: a foldable, a
tablet or any device whose smallest width is 600 dp or more, a device with a
display cutout, and an iPhone plus an iPad for the Safari items. Items 16 through
23 do not depend on signing or App Links, so the rolling debug APK is enough for
them; everything else that touches the invite still needs the release APK and
the deployed origin.

## The 29-item checklist

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

### Display, orientation, and fullscreen (items 16 through 29)

The 2026-08-21 change set made every viewport a supported layout, retired the
"rotate your device" prompt, removed the orientation lock, hid the Android
system bars, and made the browser build ask for fullscreen on the player's first
tap. The arithmetic is unit-tested and the wiring is pinned, but every claim
below is about hardware or a browser this repository does not have. Record the
device model, OS version, and result for each.

**On a physical Android phone, using the APK:**

16. **Confirm the system bars are hidden at launch and stay hidden.** Launch the
    app and start a race; expect no status bar. Swipe in from the top edge: the
    bars may appear transiently, and must then disappear again on their own,
    without a tap. Background the app and return to it, rotate the device, and
    lock and unlock it; expect the bars hidden again after each. This is the item
    with the highest chance of a surprise, because the Kotlin window code cannot
    be gated in CI — `:app:testDebugUnitTest` is plain JUnit with no Robolectric
    and no `returnDefaultValues`, so any `android.view.Window` call throws "not
    mocked". A phone is the only evidence that exists.

17. **Decide whether the navigation bar should be hidden as well.** The
    configured `hidden: true` carries no `bar` argument, so it hides the status
    bar and the navigation/gesture bar together; configuration offers no separate
    switch. Record whether hiding both is what you want. If only the status bar
    should go, say so — it becomes a JavaScript `SystemBars.hide({ bar:
    'StatusBar' })` call instead of a configuration flag.

18. **Rotate to portrait mid-race.** Expect the race to keep running: the
    activity must not be recreated, because recreation reloads the WebView and
    drops the player back to the title screen with no error anywhere, a failure
    that will otherwise be debugged as a networking bug. Expect a real portrait
    control layout — a steering band across the lower third, the four buttons
    stacked in the lower right — no rotate prompt, and controls a thumb can
    actually reach while the phone is held upright.

19. **Play a landscape race on a device with a display cutout, held both ways, if
    available.** Rotate 180° so the cutout sits on the left for one run and on
    the right for the other. Expect the drift/item cluster and the HUD to clear
    the cutout in both, and expect touches to land where the affordances are
    drawn rather than offset from them. The safe-area probe is the mechanism;
    only hardware proves it reads. Record **not available** if no cutout device
    is available.

**On a physical foldable (Pixel Fold, Galaxy Z Fold, or similar):**

20. **Fold and unfold mid-race, if available.** Expect no activity recreation,
    the canvas resized within a frame, and steering that does not swerve at the
    moment of the fold. The inner and outer panels can report different
    densities, which is why `density` was added to the activity's
    `configChanges`; an undeclared density change destroys the activity. Record
    **not available** if no foldable is available.

21. **Race on the cover screen, if available.** A cover panel of roughly
    880 × 344 lays the buttons out at 76 px rather than 88. Confirm they are
    still hittable at racing speed. Record **not available** if no foldable is
    available.

**On a tablet, or any device whose smallest width is 600 dp or more:**

22. **Cold start in portrait, if available.** Expect a playable race. Android 16
    ignores `android:screenOrientation` on these displays, so before this change
    such a device could land on a permanent rotate prompt above a canvas that was
    never resized, with no way out of it. This is the case the old manifest lock
    never protected. Record **not available** if no such device is available.

23. **Judge the button cluster on the large screen.** The controls now sit 32 to
    41 px in from the safe edge instead of a fixed 16 px, and the buttons stop
    growing at 128 px. Confirm the cluster reads as reachable rather than pinned
    into the physical corner, and that the buttons are not comically large.

**On iOS Safari:**

24. **Open the browser game on an iPhone and on an iPad, if available.** On
    iPhone expect no **Fullscreen** row in settings, because
    `Element.requestFullscreen` does not exist there and the game reports
    fullscreen as unsupported. More importantly, expect the first
    character-select tap to work: the failure being guarded against is a
    TypeError thrown inside that click handler, which would leave a tapped-in
    guest unable to pick a character at all. On iPad, which does have the API,
    expect the first menu-button tap to enter fullscreen. Record model, iOS
    version, and result for each; record **not available** for a device you do
    not have.

25. **Decide whether Add to Home Screen should be the iOS chrome-free path.**
    iPhone Safari has no Fullscreen API, so an installed home-screen copy is the
    only way to lose the browser chrome there. If that is wanted,
    `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, and
    `apple-touch-icon` must be added to the page head; none of the three exists
    today. Note also that `maximum-scale=1, user-scalable=no` has been ignored by
    iOS since iOS 10, so an iOS player can pinch-zoom the page whenever it is not
    fullscreen.

**Over the deployed HTTPS origin:**

26. **Follow a real NFC tap all the way into a race, and watch the first tap.**
    Tap a guest, land in the lobby, pick a character, and confirm that the
    character button, the guest's first legal gesture, also enters fullscreen.
    Items 4 through 8 cover the routing; this item is about what happens after
    the guest arrives. The browser test lane is plain http and the invite parser
    rejects any non-HTTPS invite URI, so the automated suite structurally cannot
    exercise the arrival path. A real deployment is the only place it can be
    checked.

**Cannot be answered from anything in this checkout:**

27. **Confirm the Android 16 large-screen opt-out property name before anyone
    reaches for it.** The local `android-36/android.jar` defines
    `PROPERTY_COMPAT_ALLOW_ORIENTATION_OVERRIDE`,
    `PROPERTY_COMPAT_ALLOW_RESIZEABLE_ACTIVITY_OVERRIDES`, and
    `PROPERTY_COMPAT_IGNORE_REQUESTED_ORIENTATION`, but no
    `PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY`. Tapkart uses none of them —
    the adaptive layout is the durable fix — but if the escape hatch is ever
    considered, check the current name and status on developer.android.com first.
    Google documents these overrides as temporary.

**Judgement calls to sign off:**

28. **Play a lap on a phone, on a tablet, and on a foldable if you have one, then
    sign off the field of view.** The four projection-band constants are policy,
    not physics: 46° of horizontal view in portrait is a design choice, and
    leaving 16:9 exactly untouched is another. What is being confirmed is feel —
    that a portrait phone does not race blinkered and a cover screen does not
    race through a fisheye.

29. **Sign off the portrait steering band.** Steering in portrait occupies the
    bottom 30% of the screen, about 253 px on a 390 × 844 phone, drawn with the
    same dashed guide as landscape. It is thumb-reachable on paper. Only hands
    confirm ergonomics; if it should be taller, shorter, or offset toward one
    side, say so.

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
