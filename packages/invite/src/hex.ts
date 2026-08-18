// PURE. No DOM, no clock, no I/O, no ambient global.

/** The one spelling of hex in this repository (contract §0): uppercase,
 *  unseparated, two characters per byte. One spelling means a string compare is
 *  a byte compare, which is what lets §5.7's golden exchange be a TSV. */
const HEX_DIGITS = '0123456789ABCDEF'

/** Uppercase, unseparated. */
export function bytesToHex(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i++) {
    const byte = b[i]
    out += HEX_DIGITS[(byte >> 4) & 0x0f]
    out += HEX_DIGITS[byte & 0x0f]
  }
  return out
}

/** `index` is the position in the space-stripped string, which is the position
 *  the caller can act on: it is where the byte actually sits. */
function nibbleAt(compact: string, index: number): number {
  const code = compact.charCodeAt(index)
  if (code >= 0x30 && code <= 0x39) return code - 0x30 // '0'-'9'
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10 // 'A'-'F'
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10 // 'a'-'f'
  throw new Error(`hexToBytes: '${compact[index]}' at index ${index} is not a hex digit`)
}

/** Accepts uppercase, lowercase and embedded spaces; throws on odd length or a
 *  non-hex character. Used by fixtures and by nothing shipped.
 *
 *  ONLY the space (0x20) is stripped. A tab is rejected on purpose: it is the
 *  column separator in the §5.8 fixtures, so a hex field that swallowed one
 *  would be a fixture with a missing column reading as a valid byte string. */
export function hexToBytes(s: string): Uint8Array {
  let compact = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === ' ') continue
    compact += c
  }
  // Validate before checking parity. A tab is the fixture column separator and
  // must be reported as the offending character even though retaining it also
  // happens to make the compact string odd-length.
  for (let i = 0; i < compact.length; i++) nibbleAt(compact, i)
  if (compact.length % 2 !== 0) {
    throw new Error(`hexToBytes: '${s}' has an odd number of hex digits (${compact.length})`)
  }
  const out = new Uint8Array(compact.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = (nibbleAt(compact, i * 2) << 4) | nibbleAt(compact, i * 2 + 1)
  }
  return out
}
