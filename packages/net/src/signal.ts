import type { IceCandidateInit } from './webrtc'

/**
 * PURE (contract §0a). Signalling is JSON over TEXT frames, not a WIRE_TAG
 * binary message (P4 Q12). Three reasons, stated so nobody "fixes" it: SDP is
 * already a multi-kilobyte UTF-8 blob and bit-packing it buys nothing;
 * MessageKind has no offer/answer/candidate members and adding three would put
 * pre-connection setup into the same union as race traffic; and a signalling
 * exchange a human can read in a devtools frame inspector is worth real
 * debugging hours on the one part of this system that fails in the field and
 * not in CI.
 *
 * The type-only import above closes a deliberate cycle with webrtc.ts, which
 * type-imports SignalMessage from here. Both edges are erased at runtime, so
 * there is no module cycle to break - only a compile-order note: `tsc` needs
 * both files present, vitest needs only the one under test.
 */
export const SIGNAL_VERSION = 1
/** An SDP with many candidates, with room. */
export const SIGNAL_MAX_BYTES = 16384

export type SignalMessage =
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; c: IceCandidateInit }
  | { t: 'iceDone' }
  | { t: 'giveUp'; reason: string }

/**
 * `from`/`to` are peer SLOTS (§4.2), so signalling and framing share one address
 * space and the server needs no second routing table.
 */
export interface SignalEnvelope {
  v: number
  from: number
  to: number
  msg: SignalMessage
}

export function encodeSignal(env: SignalEnvelope): string {
  return JSON.stringify(env)
}

/**
 * True only when `obj` carries these own keys and no others. JSON.parse DEFINES
 * a `__proto__` key as an own property rather than invoking the setter, so a
 * hostile payload's `__proto__` and `constructor` are visible here and are
 * rejected as what they are: keys this schema does not have. Strictness is
 * affordable because the envelope is versioned - a field added later arrives
 * with a new SIGNAL_VERSION.
 */
function hasExactKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(obj)
  if (keys.length !== allowed.length) return false
  for (const k of keys) {
    if (!allowed.includes(k)) return false
  }
  return true
}

/** Peer slots are one byte (§4.2), so anything outside 0..255 is not a slot. */
function isSlot(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255
}

function parseMessage(raw: unknown): SignalMessage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  switch (m['t']) {
    case 'offer':
      if (!hasExactKeys(m, ['t', 'sdp'])) return null
      return typeof m['sdp'] === 'string' ? { t: 'offer', sdp: m['sdp'] } : null
    case 'answer':
      if (!hasExactKeys(m, ['t', 'sdp'])) return null
      return typeof m['sdp'] === 'string' ? { t: 'answer', sdp: m['sdp'] } : null
    case 'ice': {
      if (!hasExactKeys(m, ['t', 'c'])) return null
      const c = m['c']
      if (typeof c !== 'object' || c === null || Array.isArray(c)) return null
      const cand = c as Record<string, unknown>
      if (!hasExactKeys(cand, ['candidate', 'sdpMid', 'sdpMLineIndex'])) return null
      if (typeof cand['candidate'] !== 'string') return null
      const sdpMid = cand['sdpMid']
      if (sdpMid !== null && typeof sdpMid !== 'string') return null
      const idx = cand['sdpMLineIndex']
      if (idx !== null && (typeof idx !== 'number' || !Number.isInteger(idx))) return null
      return { t: 'ice', c: { candidate: cand['candidate'], sdpMid, sdpMLineIndex: idx } }
    }
    case 'iceDone':
      return hasExactKeys(m, ['t']) ? { t: 'iceDone' } : null
    case 'giveUp':
      if (!hasExactKeys(m, ['t', 'reason'])) return null
      return typeof m['reason'] === 'string' ? { t: 'giveUp', reason: m['reason'] } : null
    default:
      return null
  }
}

/**
 * Checks the wire size without allocating an encoded copy. Lone surrogates are
 * counted as the three-byte U+FFFD replacement used by UTF-8 encoders, so this
 * stays total even for hostile strings that are not well-formed Unicode.
 */
function utf8BytesAtMost(text: string, maxBytes: number): boolean {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else {
        bytes += 3
      }
    } else {
      // BMP code points and lone low surrogates both occupy three bytes; the
      // latter are encoded as U+FFFD rather than throwing.
      bytes += 3
    }
    if (bytes > maxBytes) return false
  }
  return true
}

/**
 * TOTAL. Returns null on malformed JSON, a wrong version, an over-long payload,
 * an unknown `t`, an unknown key, or any field of the wrong type. NEVER throws.
 *
 * The server calls this on every text frame from every socket, so it is the
 * single most attacker-reachable function in the project - and a throw out of a
 * socket handler is an uncaught exception that exits the process and kills every
 * room in it.
 *
 * `typeof text !== 'string'` is checked despite the signature: this is the first
 * thing that touches a value off the network, and a validator that throws on a
 * caller's mistake is a validator that turns a malformed request into a 500.
 */
export function parseSignal(text: string): SignalEnvelope | null {
  if (typeof text !== 'string') return null
  // Cheap prefilter: UTF-16 code units are never more numerous than the UTF-8
  // bytes they encode to. The scan below is the definitive byte cap for strings
  // whose code-unit count alone cannot decide it.
  if (text.length > SIGNAL_MAX_BYTES) return null
  if (!utf8BytesAtMost(text, SIGNAL_MAX_BYTES)) return null

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null

  const env = raw as Record<string, unknown>
  if (!hasExactKeys(env, ['v', 'from', 'to', 'msg'])) return null
  if (env['v'] !== SIGNAL_VERSION) return null
  const from = env['from']
  const to = env['to']
  if (!isSlot(from) || !isSlot(to)) return null

  const msg = parseMessage(env['msg'])
  if (msg === null) return null

  // Field by field onto a fresh object literal, never a spread: `__proto__` and
  // `constructor` keys in a hostile payload then reach nothing at all.
  return { v: SIGNAL_VERSION, from, to, msg }
}
