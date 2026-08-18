package org.votetorrent.attestationnative

import android.util.Base64
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule

/**
 * AttestationNativeModule — the `AttestationNative` TurboModule implementation (Phase 45-02:
 * real StrongBox/TEE key attestation + Play Integrity Classic, filling the 45-01 reject-stubbed
 * skeleton). Delegates all platform-API work to [KeyAttestationHelper] / [PlayIntegrityHelper];
 * this class only wires the two-step D-11 producer seam and owns the D-09 reject-code mapping.
 *
 * OPEN QUESTION 1 — RESOLVED (see 45-02-PLAN.md "Open Question resolutions"): placeholder-
 * provision + regenerate-at-produce. `provisionDeviceKey` generates the P-256 key ONCE with an
 * empty/placeholder attestation challenge (no biometric, D-16 biometric-last);
 * `produceAttestation` deletes and REGENERATES the same alias with the real
 * `setAttestationChallenge(utf8(BOUND_DIGEST))`, biometric-gated.
 *
 * D-09 three-way reject-code mapping (two failure surfaces — 45-RESEARCH.md Common Pitfall 3):
 *   - recoverable-action: `NO_BIOMETRICS_ENROLLED` (BiometricPrompt `ERROR_NO_BIOMETRICS`).
 *   - recoverable-transient: `LOCKOUT` (`ERROR_LOCKOUT`/`ERROR_LOCKOUT_PERMANENT`) and
 *     `PLAY_INTEGRITY_ERROR` (Play Integrity network/timeout — the key-attestation leg already
 *     succeeded when this fires).
 *   - terminal: `NO_STRONGBOX_OR_TEE` (release-only — reachable ONLY because
 *     `BuildConfig.DEBUG`/`__DEV__` short-circuits the software/stub rung via
 *     [KeyAttestationHelper], D-07/D-09, so the emulator is never blocked) and
 *     `KEY_INVALIDATED_REASSOCIATE` (D-13 — routed to forced re-association, not a plain
 *     terminal failure).
 *
 * Phase 49 (D-13) extends this taxonomy for [signWithDeviceKey] with three new classes:
 *   - `cancellation`: `CANCELED` (`ERROR_CANCELED`/`ERROR_USER_CANCELED`/`ERROR_NEGATIVE_BUTTON`)
 *     — a neutral dismissal, never rendered as an error screen and never logged as a fault
 *     (49-UI-SPEC.md). 49-15/Gap B widened this classification to [produceAttestation] as well
 *     (via [KeyAttestationHelper.regenerateAttested]'s `onAuthenticationError`) — that is the
 *     ONLY signing prompt reachable from a `pm clear` device, so it, not [signWithDeviceKey], is
 *     the site that actually closes Gap B. The raw BiometricPrompt `errorCode` each of the three
 *     `onAuthenticationError` sites received is logged at INFO under the `VtSigningReject` tag,
 *     specifically so the emulator-vs-hardware question 49-13 left open (whether a real device
 *     ever delivers `ERROR_CANCELED`/5 for a negative-button/BACK dismissal, versus 10/13) stays
 *     answerable from a 49-14 hardware run.
 *   - `LOCKOUT_PERMANENT` is now a DISTINCT recoverable-transient entry, split out from the plain
 *     `LOCKOUT` class above (different remediation copy) — [regenerateAttested]'s own mapping is
 *     NOT retroactively changed to match; it keeps collapsing both lockout codes into `LOCKOUT`.
 *   - `NO_KEY_PROVISIONED` is a routing (not terminal) class: the Keystore alias simply does not
 *     exist yet, detected BEFORE any prompt is shown — 49-UI-SPEC.md's explicitly-flagged sixth
 *     condition, sibling to (not a redefinition of) D-13's original five codes.
 *
 * Plan 06 (D-16/D-26/D-18) adds [signWithRecoveryKey] and one further TERMINAL class:
 *   - `NO_DEVICE_CREDENTIAL`: the device has no screen lock configured at all. TERMINAL, not
 *     routing — distinct from `KEY_INVALIDATED_REASSOCIATE`, which routes the caller back into a
 *     re-provisioning ceremony that CAN succeed. Removing the lock screen destroys both the
 *     primary signing key and the recovery key (the device credential IS the lock screen, D-18's
 *     boundary); there is no on-device ceremony this code could route the caller into.
 */
@ReactModule(name = AttestationNativeModule.NAME)
class AttestationNativeModule(reactContext: ReactApplicationContext) :
	NativeAttestationSpec(reactContext) {

	private val keyAttestationHelper by lazy { KeyAttestationHelper(reactApplicationContext) }
	private val playIntegrityHelper by lazy { PlayIntegrityHelper(reactApplicationContext) }

	override fun getName(): String {
		return NAME
	}

	override fun provisionDeviceKey(keyAlias: String, promise: Promise) {
		try {
			val result = keyAttestationHelper.generateProvisionKey(keyAlias)
			promise.resolve(Arguments.createMap().apply {
				putString("publicKeyBase64", result.publicKeyBase64)
				putString("keyAlias", result.keyAlias)
				putString("securityLevel", result.securityLevel)
				// Phase 49 (D-04/RESEARCH Pattern 4) — the 33-byte compressed SEC1 point callers
				// must register as UserKey.PubKey; publicKeyBase64 above stays the raw SPKI DER.
				putString("publicKeyCompressedHex", result.publicKeyCompressedHex)
			})
		} catch (e: NoStrongBoxOrTeeException) {
			// D-09 terminal, release-only (see class doc comment).
			promise.reject("NO_STRONGBOX_OR_TEE", e)
		} catch (e: Exception) {
			promise.reject("PROVISION_FAILED", e)
		}
	}

	override fun provisionRecoveryKey(keyAlias: String, promise: Promise) {
		try {
			// Phase 49 (D-16) — the recovery variant of the shared keygen: one-step, no attestation
			// challenge, KeyAuthenticator.DEVICE_CREDENTIAL bitmask (API 30+) so this key survives a
			// biometric re-enrolment that would strand VOTETORRENT_AUTHORITY_SIGNING_KEY_V1.
			// 49-14 follow-up — now idempotent: an existing, still-usable alias is reused (its
			// public value returned as-is) rather than unconditionally regenerated. See
			// KeyAttestationHelper.generateRecoveryKey's doc comment.
			val result = keyAttestationHelper.generateRecoveryKey(keyAlias)
			promise.resolve(Arguments.createMap().apply {
				putString("publicKeyBase64", result.publicKeyBase64)
				putString("keyAlias", result.keyAlias)
				putString("securityLevel", result.securityLevel)
				putString("publicKeyCompressedHex", result.publicKeyCompressedHex)
			})
		} catch (e: RecoveryKeyInvalidatedException) {
			// 49-14 follow-up (D-16 observability defect) — the existing recovery key is
			// PERMANENTLY invalidated. This is the D-16 FAIL signal: it must reach JS as its own
			// distinct, classified code — never silently regenerated (that would destroy the very
			// evidence this signal exists to preserve) and never collapsed into the generic
			// PROVISION_FAILED/biometric-error bucket a caller would render as
			// "Couldn't verify your biometrics."
			promise.reject("RECOVERY_KEY_INVALIDATED", e)
		} catch (e: NoStrongBoxOrTeeException) {
			// D-09 terminal, release-only (see class doc comment) — same taxonomy as provisionDeviceKey.
			promise.reject("NO_STRONGBOX_OR_TEE", e)
		} catch (e: Exception) {
			promise.reject("PROVISION_FAILED", e)
		}
	}

	override fun produceAttestation(
		keyAlias: String,
		boundDigest: String,
		boundDigestUtf8Base64: String,
		enablePlayIntegrity: Boolean,
		promise: Promise,
	) {
		val activity = currentActivity as? FragmentActivity
		if (activity == null) {
			promise.reject("NO_ACTIVITY", "no current FragmentActivity available to host the BiometricPrompt")
			return
		}

		// ATTESTATION-CONTRACT.md §3 — these are the EXACT bytes for setAttestationChallenge; the
		// module does NOT recompute them, only decodes what JS (45-05) already computed.
		val challengeBytes: ByteArray = try {
			Base64.decode(boundDigestUtf8Base64, Base64.NO_WRAP)
		} catch (e: Exception) {
			promise.reject("INVALID_CHALLENGE_ENCODING", e)
			return
		}

		keyAttestationHelper.regenerateAttested(
			keyAlias = keyAlias,
			attestationChallengeBytes = challengeBytes,
			activity = activity,
			onResult = onResult@{ certificateChainBase64 ->
				// Gap A prerequisite (49-15, D-04/D-08) — regenerateAttested's onResult fires only
				// AFTER the alias has been deleted+regenerated and the biometric satisfied, so the
				// alias holds the attested key at exactly this moment. Resolve its public value here,
				// not from the discarded provisionDeviceKey-time key.
				val publicKeyCompressedHex: String
				try {
					publicKeyCompressedHex = keyAttestationHelper.exportPublicKeyCompressedHex(keyAlias)
				} catch (e: Exception) {
					// Fail closed rather than resolve a partial map — an undefined public key in JS
					// would register a bogus UserKey.PubKey that verify() then fails closed AND
					// silently against (swallowed exception -> false), the exact shape this phase
					// exists to eliminate.
					promise.reject("KEY_ATTESTATION_FAILED", e)
					return@onResult
				}
				finishWithPlayIntegrity(certificateChainBase64, publicKeyCompressedHex, boundDigest, enablePlayIntegrity, promise)
			},
			onKeyInvalidatedReassociate = {
				// D-13 — biometric enrollment changed since key creation; KeyAttestationHelper
				// already deleted + regenerated a fresh placeholder key. The JS caller must
				// restart the two-step D-11 ceremony from provisionDeviceKey().
				promise.reject(
					"KEY_INVALIDATED_REASSOCIATE",
					"biometric enrollment changed since this key was created — key invalidated, re-association required",
				)
			},
			onError = { code, throwable ->
				promise.reject(code, throwable)
			},
		)
	}

	override fun signWithDeviceKey(
		keyAlias: String,
		digestBase64: String,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		promise: Promise,
	) {
		val activity = currentActivity as? FragmentActivity
		if (activity == null) {
			promise.reject("NO_ACTIVITY", "no current FragmentActivity available to host the BiometricPrompt")
			return
		}

		// D-04/T-49-DER-2 (WR-10-class trap, 49-RESEARCH.md Pattern 2): plain base64 decode of the
		// RAW digest bytes — NOT the UTF-8 bytes of a base64url STRING. Deliberately UNLIKE
		// produceAttestation's boundDigestUtf8Base64 asymmetry (ATTESTATION-CONTRACT.md §3); mixing
		// the two encodings here would silently sign the wrong bytes.
		val digestBytes: ByteArray = try {
			Base64.decode(digestBase64, Base64.NO_WRAP)
		} catch (e: Exception) {
			promise.reject("INVALID_DIGEST_ENCODING", e)
			return
		}

		keyAttestationHelper.signWithDeviceKey(
			keyAlias = keyAlias,
			digestBytes = digestBytes,
			activity = activity,
			promptTitle = promptTitle,
			promptSubtitle = promptSubtitle,
			promptNegativeButton = promptNegativeButton,
			onResult = { signatureHex ->
				promise.resolve(Arguments.createMap().apply { putString("signatureHex", signatureHex) })
			},
			onKeyInvalidatedReassociate = {
				promise.reject(
					"KEY_INVALIDATED_REASSOCIATE",
					"biometric enrollment changed since this key was created — key invalidated, re-association required",
				)
			},
			onError = { code, throwable ->
				promise.reject(code, throwable)
			},
		)
	}

	override fun signWithRecoveryKey(
		keyAlias: String,
		digestBase64: String,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		promise: Promise,
	) {
		val activity = currentActivity as? FragmentActivity
		if (activity == null) {
			promise.reject("NO_ACTIVITY", "no current FragmentActivity available to host the recovery ceremony")
			return
		}

		// Same D-04/T-49-DER-2 byte-format contract as signWithDeviceKey.
		val digestBytes: ByteArray = try {
			Base64.decode(digestBase64, Base64.NO_WRAP)
		} catch (e: Exception) {
			promise.reject("INVALID_DIGEST_ENCODING", e)
			return
		}

		keyAttestationHelper.signWithRecoveryKey(
			keyAlias = keyAlias,
			digestBytes = digestBytes,
			activity = activity,
			promptTitle = promptTitle,
			promptSubtitle = promptSubtitle,
			promptNegativeButton = promptNegativeButton,
			onResult = { signatureHex ->
				promise.resolve(Arguments.createMap().apply { putString("signatureHex", signatureHex) })
			},
			onKeyInvalidatedReassociate = {
				promise.reject(
					"KEY_INVALIDATED_REASSOCIATE",
					"recovery key invalidated — re-association required",
				)
			},
			onError = { code, throwable ->
				promise.reject(code, throwable)
			},
		)
	}

	/**
	 * On-device biometric success: request the Play Integrity leg (D-12 gated) and the
	 * device ID (D-14), then assemble the native-side attestation result map. JS (45-05) is
	 * responsible for building the final `DeviceAttestation` from this map.
	 */
	private fun finishWithPlayIntegrity(
		certificateChainBase64: List<String>,
		publicKeyCompressedHex: String,
		boundDigest: String,
		enablePlayIntegrity: Boolean,
		promise: Promise,
	) {
		playIntegrityHelper.requestToken(
			boundDigest = boundDigest,
			enablePlayIntegrity = enablePlayIntegrity,
			onResult = { integrityToken ->
				val androidId = playIntegrityHelper.getDeviceId()
				promise.resolve(Arguments.createMap().apply {
					putArray("certificateChainBase64", Arguments.createArray().apply {
						certificateChainBase64.forEach { pushString(it) }
					})
					putString("integrityToken", integrityToken)
					putString("androidId", androidId)
					putDouble("attestationTimeMillis", System.currentTimeMillis().toDouble())
					// Gap A prerequisite (49-15, D-04/D-08) — the POST-regeneration public key;
					// see produceAttestation's onResult lambda for why this must be exported here
					// rather than reused from provisionDeviceKey's earlier resolution.
					putString("publicKeyCompressedHex", publicKeyCompressedHex)
				})
			},
			onError = { e ->
				// recoverable-transient (D-09) — the key-attestation leg already succeeded;
				// only the independent Play Integrity leg failed (network/timeout/quota).
				promise.reject("PLAY_INTEGRITY_ERROR", e)
			},
		)
	}

	companion object {
		const val NAME = "AttestationNative"
	}
}
