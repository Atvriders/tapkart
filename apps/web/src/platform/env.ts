// ADAPTER. Contract §10.1. The origin decision itself remains in the pure PWA
// module; this file only supplies the build and device values.

import { chooseOrigin, stripTrailingSlash } from '../pwa/origin'

/** The deployed origin baked into a native build, without a trailing slash. */
export const BUILD_ORIGIN: string = stripTrailingSlash(
  (import.meta.env.VITE_TAPKART_ORIGIN ?? '').trim(),
)

/** The single permitted platform check in the web application. */
export const IS_NATIVE: boolean =
  (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
    ?.isNativePlatform?.() === true

/** The public origin used by every invite URI. */
export function appOrigin(): string {
  const location = (globalThis as { location?: { origin?: string } }).location
  return chooseOrigin(IS_NATIVE, BUILD_ORIGIN, location?.origin ?? '')
}
