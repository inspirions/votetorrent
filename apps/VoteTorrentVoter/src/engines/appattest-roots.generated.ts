// appattest-roots.generated.ts — bundled offline snapshot of Apple's App Attest
// trust-anchor root certificate (Phase 51, D-04 offline posture).
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ NOT YET PROVISIONED — this snapshot is deliberately EMPTY.               │
// │ `AppAttestVerifier` fails closed on an empty pool and reports            │
// │ "Apple App Attest root material is not provisioned — see SETUP.md",      │
// │ so no attestation can be accepted until a human populates it.            │
// └──────────────────────────────────────────────────────────────────────────┘
//
// It is empty ON PURPOSE rather than pre-filled. A trust anchor is the single
// value in this system that must not be taken on faith from an automated step:
// embedding an unverified or truncated root would not fail loudly, it would
// silently define what "genuine Apple hardware" means. SETUP.md §4d gives the
// fetch-and-verify procedure, which includes an out-of-band fingerprint check
// that a build script cannot perform for you.
//
// This mirrors `apps/VoteTorrentAuthority/src/engines/attestation-roots.generated.ts`
// (the Google hardware-attestation equivalent) in shape and in the rule that it
// is refreshed out-of-band and NEVER fetched at verify-time.
//
// Static import ONLY — dynamic require() breaks Metro (Phase 16-07 lesson).
//
// `Buffer` MUST be imported explicitly from the `buffer` module — it is NOT a
// Hermes global (see vote-engine/src/utils.ts).
import { Buffer } from 'buffer'

/**
 * Base64-encoded DER of Apple's App Attest root certificate(s).
 *
 * Populate from https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
 * following SETUP.md §4d — strip the PEM header/footer/newlines, verify the certificate is
 * genuinely self-signed AND that its SHA-256 fingerprint matches Apple's published value before
 * committing.
 */
const APPLE_APP_ATTEST_ROOTS_BASE64: readonly string[] = [
  // e.g. 'MIICITCCAaeg...'
]

/**
 * Decoded pinned roots, injected into `AppAttestVerifier`. Empty until provisioned — which the
 * verifier treats as a fail-closed configuration error, not as "accept anything".
 */
export const PINNED_APP_ATTEST_ROOTS_DER: Uint8Array[] =
  APPLE_APP_ATTEST_ROOTS_BASE64.map((b64) => new Uint8Array(Buffer.from(b64, 'base64')))

/** True once a real root has been embedded. Call sites should surface this in diagnostics. */
export const APP_ATTEST_ROOTS_PROVISIONED: boolean = PINNED_APP_ATTEST_ROOTS_DER.length > 0
