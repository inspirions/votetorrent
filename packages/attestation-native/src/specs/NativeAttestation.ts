/**
 * NativeAttestation.ts — codegen source of truth for the `AttestationNative` TurboModule
 * (Phase 45-01 scaffold). RN 0.78 new-arch codegen generates the Kotlin
 * `NativeAttestationSpec` base class from this file (see `package.json`'s
 * `codegenConfig`); `AttestationNativeModule.kt` extends that generated base class.
 *
 * D-11 two-step producer seam:
 *   (1) provisionDeviceKey(keyAlias) — generates/returns the hardware-backed P-256
 *       public key (biometric-gated). The authority-issued challenge is bound to
 *       this key's public value.
 *   (2) produceAttestation(keyAlias, boundDigest, boundDigestUtf8Base64, enablePlayIntegrity)
 *       — answers the challenge: returns the key-attestation cert chain + (optionally)
 *       a Play Integrity Classic token.
 *
 * TurboModule codegen types are restrictive (no arbitrary interfaces) — both methods
 * return `Object` (a `WritableMap` on the Kotlin side); the JS wrapper
 * (`RealAttestationProducer`, landing in 45-05) parses/validates the returned shape,
 * exactly as `react-native-localize` returns `Object` for `getNumberFormatSettings()`.
 *
 * OPEN QUESTION 1 (45-RESEARCH.md, NOT resolved by this scaffold plan — do not narrow):
 * this signature deliberately supports BOTH candidate implementations for WHEN the
 * real attested key-generation happens:
 *   (a) `provisionDeviceKey` generates the real attested key immediately, using a
 *       placeholder `setAttestationChallenge` value, then `produceAttestation`
 *       re-reads/regenerates the attestation-carrying cert chain against the real
 *       `boundDigest` once the challenge exists; or
 *   (b) `provisionDeviceKey` only returns a public key (possibly from a
 *       non-attested or previously-provisioned key) and ALL attested key generation
 *       is deferred to `produceAttestation`, which receives the real `boundDigest`
 *       up front and can generate-with-challenge in one step.
 * 45-02 resolves which path via an on-device/emulator experiment (45-RESEARCH.md
 * Open Question 1 / Assumption A2). This spec's shape must not be narrowed to
 * foreclose either option until that experiment lands.
 */
import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

export interface Spec extends TurboModule {
	/**
	 * Generates (or returns the existing) hardware-backed P-256 signing key under
	 * `keyAlias`. Biometric-gated per D-06/D-17. Resolves `{ publicKeyBase64, keyAlias,
	 * publicKeyCompressedHex }` — `publicKeyBase64` remains the raw X.509 SPKI DER
	 * (base64), consumed only by the Phase 45 attestation path; `publicKeyCompressedHex`
	 * (Phase 49, D-04/RESEARCH Pattern 4) is the NEW 33-byte compressed SEC1 point,
	 * hex-encoded. Callers registering a `UserKey.PubKey` MUST use
	 * `publicKeyCompressedHex` — `publicKeyBase64` is a DER-wrapped blob, not a valid
	 * `UserKey.PubKey`, and will fail closed (and, per `verify()`'s swallow-all
	 * exception handling, silently) if registered as one.
	 * Scaffold (45-01): rejects with a NOT_IMPLEMENTED-class code — no real Keystore
	 * logic yet (lands in 45-02).
	 */
	provisionDeviceKey(keyAlias: string): Promise<Object>

	/**
	 * Answers an already-issued challenge bound to the key from `provisionDeviceKey`.
	 * `boundDigest` is the base64url `Digest(nonce, deviceKey)` string (Play Integrity
	 * Classic nonce, AS-IS); `boundDigestUtf8Base64` is the base64 encoding of the
	 * UTF-8 bytes of that same string (the Keystore `setAttestationChallenge` payload
	 * — an intentional asymmetry, see `packages/vote-engine/ATTESTATION-CONTRACT.md`).
	 * `enablePlayIntegrity` independently gates the Play Integrity Classic leg (D-12).
	 * Resolves the attestation result map (cert chain + optional integrity token).
	 * Scaffold (45-01): rejects with a NOT_IMPLEMENTED-class code — no real
	 * attestation logic yet (lands in 45-02).
	 */
	produceAttestation(
		keyAlias: string,
		boundDigest: string,
		boundDigestUtf8Base64: string,
		enablePlayIntegrity: boolean,
	): Promise<Object>

	/**
	 * Phase 49 (D-06/D-04): produces a biometric-gated, hardware-backed P-256 signature
	 * over `digestBase64` using the key under `keyAlias`. Resolves
	 * `{ signatureHex: string }` — a 64-byte compact, low-S, hex-encoded signature
	 * (`r||s`, `s` normalized into the lower half of the P-256 order, matching
	 * `@noble/curves` v2's `verify()` defaults: `prehash: true`, `lowS: true`,
	 * `format: 'compact'`). Callers must NOT re-normalize the returned signature.
	 *
	 * Byte-format contract for `digestBase64` — a silent-failure trap if violated:
	 * this is **plain base64 (`Base64.NO_WRAP`) of the RAW digest bytes**, never
	 * base64url, and emphatically never the UTF-8 bytes of a base64url string. This is
	 * deliberately UNLIKE `produceAttestation`'s `boundDigestUtf8Base64` argument, whose
	 * UTF-8-of-a-string encoding is a documented asymmetry required by
	 * `setAttestationChallenge` (see `ATTESTATION-CONTRACT.md` §3). Repeating that
	 * asymmetry here would silently sign the wrong bytes — `verify()` swallows
	 * exceptions and returns `false`, so a wrong-bytes signature looks like an ordinary
	 * "invalid signature" rejection, not a crash.
	 *
	 * `promptTitle`/`promptSubtitle`/`promptNegativeButton` are resolved JS-side via
	 * `t()` — a deliberate widening beyond the Phase 45 precedent, which hardcodes
	 * English in `KeyAttestationHelper.kt`. This project's standing rule is that
	 * user-facing copy lives in `src/i18n/index.ts`. There are exactly 4 distinct
	 * string values across all three call shapes (per-use, provisioning, recovery) —
	 * only the subtitle varies (see `49-UI-SPEC.md` §"Native BiometricPrompt string
	 * contract").
	 *
	 * Rejects with one of the typed codes: `CANCELED`, `NO_BIOMETRICS_ENROLLED`,
	 * `LOCKOUT`, `LOCKOUT_PERMANENT`, `BIOMETRIC_ERROR`, `KEY_INVALIDATED_REASSOCIATE`,
	 * `NO_KEY_PROVISIONED`, `NO_ACTIVITY`, `INVALID_DIGEST_ENCODING`.
	 */
	signWithDeviceKey(
		keyAlias: string,
		digestBase64: string,
		promptTitle: string,
		promptSubtitle: string,
		promptNegativeButton: string,
	): Promise<Object>

	/**
	 * Phase 49 (D-16/D-07): provisions the Authority app's second Keystore alias — a
	 * `DEVICE_CREDENTIAL`-authenticated key that `setInvalidatedByBiometricEnrollment` does NOT
	 * govern, so it survives a biometric re-enrolment that would otherwise permanently strand the
	 * primary `signWithDeviceKey` alias. Unlike `provisionDeviceKey`'s two-step placeholder-then-
	 * attested dance (D-11, a Voter-app attestation concern this key has no analog for), this
	 * resolves the SAME shape in one step — `{ publicKeyBase64, keyAlias, publicKeyCompressedHex }`
	 * — with no attestation challenge: this key exists purely to sign a replacement key back into
	 * `UserKey` (D-16), not to produce a verifier-consumed cert chain.
	 *
	 * `keyAlias` should be the canonical `VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1` value (distinct
	 * from `VOTETORRENT_AUTHORITY_SIGNING_KEY_V1` and from the Voter app's
	 * `VOTETORRENT_DEVICE_KEY_V1` — D-07, different apps, different threat surfaces).
	 *
	 * **Unproven until D-24 leg 3 on real hardware** — do not take biometric-re-enrolment survival
	 * from the docs (D-16).
	 */
	provisionRecoveryKey(keyAlias: string): Promise<Object>
}

export default TurboModuleRegistry.getEnforcing<Spec>('AttestationNative')
