import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { encodeRegistrationCodeBits, REASSOCIATION_UNRESOLVED_REGISTRANT_ID, REGISTRATION_CODE_DOMAIN, ReassociationError } from '@votetorrent/vote-core'
import type { Signature } from '@votetorrent/vote-core'

/**
 * deriveRegistrationCodeWith(registrantId, sign) — 62-18 (D-01, D-45).
 *
 * The registering device's ONLY route to a re-join code: the registrant's identity key never
 * leaves the device (D-01), so the code is derived here as a pure function of a SIGNING CALLBACK
 * over a fixed, domain-separated digest — never from a raw key. The authority can never compute
 * this value itself; it only ever compares a PRESENTED code against the sealed copy carried
 * inside the registering device's own `RegistrationRequestStaging` row (D-45) — never by deriving
 * one independently.
 *
 * Re-showing the code (62-28: "show my code again") depends on this being REPRODUCIBLE from the
 * same key — so the digest is signed TWICE and the two signatures are required to be byte
 * identical. A hedged/nondeterministic signer (noble's `extraEntropy: true`, or any hardware
 * signer that randomizes `k`) would silently make the code unreproducible on a second call, so
 * that case is rejected outright rather than shipped as a code nobody could ever re-derive.
 *
 * Uses `@noble/hashes` (`sha2.js`, `utils.js`) only — no Node Buffer global (Hermes gate).
 */
export async function deriveRegistrationCodeWith (
  registrantId: string,
  sign: (digest: Uint8Array) => Promise<Signature>
): Promise<string> {
  if (typeof registrantId !== 'string' || registrantId.length === 0 || registrantId === REASSOCIATION_UNRESOLVED_REGISTRANT_ID) {
    throw new ReassociationError('invalid-argument', 'deriveRegistrationCodeWith: registrantId must be a non-empty, non-sentinel string')
  }

  const digest = sha256(utf8ToBytes(`${REGISTRATION_CODE_DOMAIN}\n${registrantId}`))

  const first = await sign(digest)
  const second = await sign(digest)
  if (first.signature !== second.signature) {
    throw new ReassociationError(
      'non-deterministic-signer',
      'deriveRegistrationCodeWith: signer produced two different signatures over the same digest — the registration code must be reproducible from the identity key alone'
    )
  }

  const material = sha256(concatBytes(utf8ToBytes(`${REGISTRATION_CODE_DOMAIN}/code`), hexToBytes(first.signature)))
  return encodeRegistrationCodeBits(material)
}
