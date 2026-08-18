// PURE. Contract §10.3, and it is where C-3 lives. No DOM: `location` and the
// native flag arrive as arguments, which is what lets both halves be unit-tested
// with no browser.

/** Trailing slash removed; '' stays ''. Whitespace is NOT touched — trimming is
 *  chooseOrigin's, because only chooseOrigin knows that an all-whitespace build
 *  origin means "unset". */
export function stripTrailingSlash(origin: string): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin
}

/** C-3, as a function.
 *
 *  - Not native  -> `locationOrigin`. The running web app builds its own invite
 *    URIs from where it is actually served, so a self-hoster on any domain works
 *    with NO REBUILD and the origin is correct by construction.
 *  - Native      -> `buildOrigin`. Inside the Capacitor WebView `location.origin`
 *    is the WebView's local scheme, NOT the deployed origin, so using it there
 *    would emit an invite URI no guest can open — the silent failure C-3 exists
 *    to prevent. Per F-P5-11 the APK is a domain-specific build anyway, and its
 *    baked origin is the SAME variable that produced its intent filter, which is
 *    exactly what keeps §3's values 1 and 2 agreeing.
 *
 *  THROWS when `isNative` and `buildOrigin` is empty. An APK built with no
 *  TAPKART_ORIGIN would otherwise advertise an invite that resolves nowhere, and
 *  it would do it silently on the one device that has HCE. Failing at module
 *  load, in a build CI runs, is the only loud moment available. */
export function chooseOrigin(
  isNative: boolean,
  buildOrigin: string,
  locationOrigin: string,
): string {
  if (!isNative) return stripTrailingSlash(locationOrigin.trim())
  const baked = stripTrailingSlash(buildOrigin.trim())
  if (baked === '') {
    throw new Error(
      'chooseOrigin: native build has no TAPKART_ORIGIN. An APK built without it would ' +
        'advertise an invite URI that resolves nowhere, on the only device that has HCE.',
    )
  }
  return baked
}
