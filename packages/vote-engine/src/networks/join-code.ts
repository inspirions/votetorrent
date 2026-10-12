// src/networks/join-code.ts — spike 100: the text an authority hands a voter so the voter's
// phone can join the authority's network.
//
// A join code is a cadre invitation (cadre-core `encodeCadreInvitation`, already base64url)
// plus the network's founding anchor: the strand id, the four keys that select the six
// founding rows, and the digest those rows must hash to. The voter's phone redeems the
// invitation, opens the strand, and accepts the network only when the replicated founding
// rows hash to `digest` (`NetworksEngine.joinFromStrand`). The fingerprint a voter compares
// against the authority's published one is `foundingBundleFingerprint(digest)`, the same
// fingerprint a founding bundle shows.
//
// Wire form: `vtjoin1.` + unpadded base64url of the JSON. The JSON is written as pure ASCII
// (every non-ASCII character escaped as \uXXXX), so neither direction needs a UTF-8 codec:
// the phone runtime (Hermes) is not guaranteed a `TextDecoder` (election-block.ts's header).
// About 1.3 KB for a one-member invitation, so the same string still fits one QR code later.

import type { NetworkJoinAnchor } from '@votetorrent/vote-core'
import { bytesToBase64url } from '../utils.js'
import { foundingBundleFingerprint } from './founding-bundle.js'

export const NETWORK_JOIN_CODE_PREFIX = 'vtjoin1.'

/** A join code's decoded content. */
export interface NetworkJoinCode extends NetworkJoinAnchor {
  readonly v: 1
  /** cadre-core `encodeCadreInvitation` output. Opaque here: vote-engine never imports cadre-core (D-03). */
  readonly invitation: string
}

export type NetworkJoinCodeDecodeResult =
  | { readonly ok: true; readonly code: NetworkJoinCode; readonly fingerprint: string }
  | { readonly ok: false; readonly reason: 'malformed' | 'unsupported-version' }

/** Bound on the text a decoder will look at (a pasted code is ~1.3 KB). */
const MAX_CODE_CHARS = 16_384
/** Bound on the display name (the Network row's own name wins once joined). */
const MAX_NAME_CHARS = 256

const TOP_KEYS = ['digest', 'genesis', 'invitation', 'name', 'networkHash', 'v'] as const
const GENESIS_KEYS = ['adminEffectiveAt', 'authorityId', 'signerKey', 'userId'] as const
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function asciiJson (value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function decodeBase64urlAscii (text: string): string | null {
  let out = ''
  let acc = 0
  let bits = 0
  for (const ch of text) {
    const v = BASE64URL_ALPHABET.indexOf(ch)
    if (v < 0) return null
    acc = ((acc << 6) | v) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      const byte = (acc >> bits) & 0xff
      if (byte > 0x7f) return null // the encoder only ever writes ASCII
      out += String.fromCharCode(byte)
    }
  }
  return out
}

function hasExactKeys (obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(obj).sort()
  return own.length === keys.length && own.every((k, i) => k === keys[i])
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** Encode a join code. Throws only on a code that would not decode (a programming error). */
export function encodeNetworkJoinCode (code: NetworkJoinCode): string {
  const json = asciiJson({
    v: code.v,
    invitation: code.invitation,
    networkHash: code.networkHash,
    name: code.name,
    genesis: {
      userId: code.genesis.userId,
      signerKey: code.genesis.signerKey,
      authorityId: code.genesis.authorityId,
      adminEffectiveAt: code.genesis.adminEffectiveAt
    },
    digest: code.digest
  })
  const bytes = new Uint8Array(json.length)
  for (let i = 0; i < json.length; i++) bytes[i] = json.charCodeAt(i)
  const text = NETWORK_JOIN_CODE_PREFIX + bytesToBase64url(bytes)
  if (!decodeNetworkJoinCode(text).ok) throw new Error('encodeNetworkJoinCode: the code does not decode')
  return text
}

/**
 * Decode a pasted join code. Never throws. Surrounding whitespace (and line breaks a chat app
 * may insert) is ignored; anything else that is not exactly the encoder's shape is `malformed`.
 * A well-formed code from a newer encoder (`v` other than 1) is `unsupported-version`.
 */
export function decodeNetworkJoinCode (text: unknown): NetworkJoinCodeDecodeResult {
  if (typeof text !== 'string') return { ok: false, reason: 'malformed' }
  const compact = text.replace(/\s+/g, '')
  if (compact.length > MAX_CODE_CHARS || !compact.startsWith(NETWORK_JOIN_CODE_PREFIX)) {
    return { ok: false, reason: 'malformed' }
  }
  const json = decodeBase64urlAscii(compact.slice(NETWORK_JOIN_CODE_PREFIX.length))
  if (json === null) return { ok: false, reason: 'malformed' }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'malformed' }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.v === 'number' && obj.v !== 1) return { ok: false, reason: 'unsupported-version' }
  if (obj.v !== 1 || !hasExactKeys(obj, TOP_KEYS)) return { ok: false, reason: 'malformed' }
  if (!isNonEmptyString(obj.invitation) || !isNonEmptyString(obj.networkHash) || !isNonEmptyString(obj.digest)) {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof obj.name !== 'string' || obj.name.length > MAX_NAME_CHARS) return { ok: false, reason: 'malformed' }
  const genesis = obj.genesis
  if (genesis === null || typeof genesis !== 'object' || Array.isArray(genesis)) return { ok: false, reason: 'malformed' }
  const g = genesis as Record<string, unknown>
  if (!hasExactKeys(g, GENESIS_KEYS) || !GENESIS_KEYS.every((k) => isNonEmptyString(g[k]))) {
    return { ok: false, reason: 'malformed' }
  }
  let fingerprint: string
  try {
    fingerprint = foundingBundleFingerprint(obj.digest)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  return {
    ok: true,
    fingerprint,
    code: {
      v: 1,
      invitation: obj.invitation,
      networkHash: obj.networkHash,
      name: obj.name,
      genesis: {
        userId: g.userId as string,
        signerKey: g.signerKey as string,
        authorityId: g.authorityId as string,
        adminEffectiveAt: g.adminEffectiveAt as string
      },
      digest: obj.digest
    }
  }
}
