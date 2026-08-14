package org.votetorrent.attestationnative

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Request code for the API 24-29 [KeyguardManager.createConfirmDeviceCredentialIntent] fallback
 * (D-26) — scoped to this module (an arbitrary but stable value unlikely to collide with any
 * other `startActivityForResult` call in the host app) so [ActivityEventListener.onActivityResult]
 * can distinguish this ceremony's result from any other in-flight activity result.
 */
private const val RECOVERY_KEY_CONFIRM_CREDENTIAL_REQUEST_CODE = 49160

private const val ANDROID_KEYSTORE = "AndroidKeyStore"

/**
 * Phase 49 (D-07) — canonical Authority Keystore aliases, distinct from the Voter app's device
 * signing key alias (`real-attestation-producer.ts`'s `KEY_ALIAS` constant). Different apps,
 * different threat surfaces, independent rotation, and the Authority app has no attestation flow
 * to bind to — so these are NOT aliased to, or derived from, the Voter constant. Both must stay
 * stable for the same reason the Voter alias must: [KeyPermanentlyInvalidatedException] detection
 * (D-13) depends on re-resolving a *known* alias, not a freshly-generated one.
 *
 * [VOTETORRENT_AUTHORITY_SIGNING_KEY_V1] is the primary per-use `AUTH_BIOMETRIC_STRONG` signing
 * key (provisioned/used via the existing [generateProvisionKey]/[regenerateAttested]/
 * [signWithDeviceKey] path). [VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1] is the D-16 second key that
 * `setInvalidatedByBiometricEnrollment` does NOT govern, provisioned/used via
 * [generateRecoveryKey]/[signWithRecoveryKey].
 */
const val VOTETORRENT_AUTHORITY_SIGNING_KEY_V1 = "VOTETORRENT_AUTHORITY_SIGNING_KEY_V1"
const val VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1 = "VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1"

/**
 * Which authenticator [KeyGenParameterSpec.Builder.setUserAuthenticationParameters] requests at
 * key-creation time (API 30+ only — see the `Build.VERSION.SDK_INT >= 30` guards below). The `0`
 * timeout argument is ALWAYS per-use (D-10) regardless of which member is selected; D-10 rejected
 * any non-zero validity duration explicitly, since its boundary is a wall clock and any code path
 * signing inside the window would inherit the authentication silently.
 */
enum class KeyAuthenticator {
	/** Per-use biometric — the primary Authority signing key and the Voter attestation key. */
	BIOMETRIC_STRONG,

	/**
	 * Per-use device credential (PIN/pattern/password OR biometric, whichever the lock screen
	 * accepts) — the D-16 recovery key. `setInvalidatedByBiometricEnrollment` governs only
	 * biometric-auth keys, so a key created with this authenticator SURVIVES a biometric
	 * re-enrolment that would otherwise permanently strand [BIOMETRIC_STRONG]-authenticated keys.
	 * **Unproven until D-24 leg 3 on real hardware** — do not take this from the docs (D-16).
	 */
	DEVICE_CREDENTIAL,
}

/**
 * P-256 curve order `n` and `n/2` (49-RESEARCH.md Pattern 3, computed from
 * `@noble/curves/nist.js:17`) — used by [derToCompactLowS]'s low-S normalization, which must match
 * `@noble/curves` v2's `lowS: true` verify-side default exactly.
 */
private val P256_ORDER = BigInteger(
	"ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16
)
private val P256_HALF_ORDER = P256_ORDER.shiftRight(1)

/**
 * DER `SEQUENCE { INTEGER r, INTEGER s }` (Java `Signature.sign()`'s output for an EC key) ->
 * 64-byte compact `r||s`, with `s` normalized to the lower half of the P-256 order (D-04,
 * 49-RESEARCH.md Pattern 3 — copied verbatim, no third-party ASN.1 dependency per "Don't
 * Hand-Roll": a general ASN.1 library is unjustified weight for this one fixed-shape parse).
 *
 * This is the byte-level contract `signWithDeviceKey` must satisfy for the signature to verify
 * against `@noble/curves` v2's `p256.verify()` defaults (`prehash: true`, `lowS: true`,
 * `format: 'compact'`) with zero JS-side changes.
 */
private fun derToCompactLowS(der: ByteArray): ByteArray {
	// Minimal ASN.1 walk: SEQUENCE tag(0x30) + length, then two INTEGER(0x02) TLVs. Assumes
	// short-form DER length encoding throughout — always true for a P-256 ECDSA signature (r and s
	// are each <= 33 bytes, well under the 128-byte long-form threshold); the require() below is
	// cheap insurance against a misparse rather than a real expected failure mode.
	require(der.size >= 2 && der[0] == 0x30.toByte()) { "expected DER SEQUENCE tag" }
	require((der[1].toInt() and 0x80) == 0) { "unexpected long-form DER SEQUENCE length in ECDSA signature" }
	var offset = 2 // skip SEQUENCE tag + length byte

	// First INTEGER TLV -> r. Two-arg unsigned BigInteger constructor: a DER INTEGER's payload can
	// itself carry a leading 0x00 sign-pad byte, which must NOT be interpreted as sign information a
	// second time — the single-arg (signed) BigInteger(bytes) constructor would double-count it.
	require(der[offset] == 0x02.toByte()) { "expected DER INTEGER tag for r" }
	offset++
	val rLen = der[offset].toInt() and 0xFF
	offset++
	val rBytes = der.copyOfRange(offset, offset + rLen)
	offset += rLen
	val r = BigInteger(1, rBytes)

	// Second INTEGER TLV -> s. Same unsigned-constructor discipline as r above.
	require(der[offset] == 0x02.toByte()) { "expected DER INTEGER tag for s" }
	offset++
	val sLen = der[offset].toInt() and 0xFF
	offset++
	val sBytes = der.copyOfRange(offset, offset + sLen)
	offset += sLen
	var s = BigInteger(1, sBytes)

	if (s > P256_HALF_ORDER) {
		s = P256_ORDER.subtract(s) // low-S normalization (matches noble's lowS:true default)
	}
	return fixed32(r) + fixed32(s)
}

/**
 * `BigInteger` -> exactly 32 big-endian bytes. `BigInteger.toByteArray()` is signed
 * two's-complement output: for a positive 256-bit value whose top bit is set it PREPENDS an extra
 * `0x00` byte (33 bytes total) to keep the result non-negative — the 33-byte branch strips exactly
 * that byte. For small values it can return FEWER than 32 bytes — the left-pad branch handles that
 * (effectively unreachable for real signature scalars, but guards a real-world r/s that starts with
 * several zero bits).
 */
private fun fixed32(n: BigInteger): ByteArray {
	val raw = n.toByteArray()
	return when {
		raw.size == 32 -> raw
		raw.size == 33 && raw[0] == 0.toByte() -> raw.copyOfRange(1, 33)
		raw.size < 32 -> ByteArray(32 - raw.size) + raw
		else -> throw IllegalStateException("unexpected scalar byte length: ${raw.size}")
	}
}

/**
 * X.509 `SubjectPublicKeyInfo` DER (the shape `java.security.PublicKey.getEncoded()` returns for an
 * AndroidKeyStore EC key) -> 33-byte compressed SEC1 point, hex-encoded lowercase (49-RESEARCH.md
 * Pattern 4). The SPKI BIT STRING payload for a P-256/`secp256r1` key is the UNCOMPRESSED 65-byte
 * point `0x04 || X(32) || Y(32)`; every `UserKey.PubKey` in this schema is a 33-byte COMPRESSED
 * point (`device-user.ts:50`'s `secp256k1.getPublicKey(privKey, true)` convention) — storing the
 * raw SPKI blob (or the uncompressed 65-byte point) as-is would silently break the fixed-shape
 * `UserKey.PubKey` column and every `verify()` call that decodes it.
 *
 * Does NOT hardcode a fixed byte offset for the point (RESEARCH Assumption A2 flags that an OEM
 * Keystore's named-curve OID encoding could shift it) — instead walks the outer SEQUENCE, skips the
 * `AlgorithmIdentifier` SEQUENCE using its own declared length, then reads the BIT STRING (tag
 * 0x03), skips its unused-bits byte, and requires the first payload byte to be 0x04 with an exactly
 * 65-byte payload. A malformed input throws naming the actual first byte and payload length — the
 * value D-24 leg 1 reads off logcat to confirm this parse on-device before it is trusted.
 */
private fun spkiToCompressedPointHex(spki: ByteArray): String {
	require(spki.isNotEmpty() && spki[0] == 0x30.toByte()) { "expected outer DER SEQUENCE (SubjectPublicKeyInfo)" }
	var offset = 1
	val (outerLen, outerLenBytes) = readDerLength(spki, offset)
	offset += outerLenBytes
	val outerEnd = offset + outerLen

	// AlgorithmIdentifier SEQUENCE — skip using its own declared length, never a hardcoded offset.
	require(offset < outerEnd && spki[offset] == 0x30.toByte()) { "expected AlgorithmIdentifier SEQUENCE" }
	offset++
	val (algLen, algLenBytes) = readDerLength(spki, offset)
	offset += algLenBytes + algLen

	// BIT STRING (tag 0x03): 1-byte "unused bits" count (0 for a byte-aligned EC point) precedes
	// the point payload.
	require(offset < outerEnd && spki[offset] == 0x03.toByte()) { "expected BIT STRING tag for SPKI public key" }
	offset++
	val (bitStrLen, bitStrLenBytes) = readDerLength(spki, offset)
	offset += bitStrLenBytes
	val unusedBits = spki[offset].toInt() and 0xFF
	require(unusedBits == 0) { "unexpected non-zero BIT STRING unused-bits count: $unusedBits" }
	offset++
	val payloadLen = bitStrLen - 1
	val payload = spki.copyOfRange(offset, offset + payloadLen)

	val firstByte = payload.getOrNull(0)?.toInt()?.and(0xFF)
	require(firstByte == 0x04 && payload.size == 65) {
		"malformed EC SubjectPublicKeyInfo payload — expected 0x04-prefixed 65-byte uncompressed " +
			"point, got first byte ${firstByte?.let { "0x%02x".format(it) } ?: "<empty>"} and " +
			"payload length ${payload.size}"
	}

	val x = payload.copyOfRange(1, 33)
	val y = payload.copyOfRange(33, 65)
	val yIsEven = (y[y.size - 1].toInt() and 1) == 0
	val prefix: Byte = if (yIsEven) 0x02 else 0x03
	val compressed = byteArrayOf(prefix) + x
	return compressed.joinToString("") { "%02x".format(it) }
}

/** Short-form-or-long-form DER length reader. Returns (length, bytesConsumedForTheLengthField). */
private fun readDerLength(bytes: ByteArray, offset: Int): Pair<Int, Int> {
	val first = bytes[offset].toInt() and 0xFF
	return if ((first and 0x80) == 0) {
		first to 1
	} else {
		val numLenBytes = first and 0x7F
		var len = 0
		for (i in 1..numLenBytes) {
			len = (len shl 8) or (bytes[offset + i].toInt() and 0xFF)
		}
		len to (1 + numLenBytes)
	}
}

/** Result of a (placeholder or attested) P-256 keygen. */
data class ProvisionResult(
	val publicKeyBase64: String,
	val keyAlias: String,
	// "strongbox" | "tee" | "software" — the last rung is unreachable in a release build (T-45-04/CR-03).
	val securityLevel: String,
	// 33-byte compressed SEC1 point, hex-encoded (D-04/RESEARCH Pattern 4) — the form callers MUST
	// register as `UserKey.PubKey`. `publicKeyBase64` above remains the raw X.509 SPKI DER,
	// consumed only by the Phase 45 attestation cert-chain path.
	val publicKeyCompressedHex: String,
)

/**
 * Terminal (release-only) failure — no StrongBox/TEE hardware backing available and the
 * debug-only software/stub rung is unreachable because [BuildConfig.DEBUG] is false. Fail-closed
 * per D-07/CR-03 — a release build must NEVER silently fall to a software key.
 */
class NoStrongBoxOrTeeException(cause: Throwable) : Exception(
	"no StrongBox or TEE hardware key backing available on this device (release build — fail-closed, D-07/CR-03)",
	cause,
)

/**
 * KeyAttestationHelper — P-256 StrongBox->TEE->(debug-only)stub keygen, per-use biometric gate,
 * cert-chain export (leaf+intermediates, no root), and KeyPermanentlyInvalidatedException
 * handling (Phase 45-02: D-03/D-06/D-07/D-13/D-15b/D-17).
 *
 * Open Q1 (LOCKED, see 45-02-PLAN.md "Open Question resolutions"): placeholder-provision +
 * regenerate-at-produce.
 *   - [generateProvisionKey] creates the P-256 key ONCE with an EMPTY/placeholder attestation
 *     challenge, no biometric (D-16 "biometric-last" — mere key creation, not a real attestation).
 *   - [regenerateAttested] DELETES and REGENERATES the SAME alias with the REAL
 *     setAttestationChallenge(utf8(BOUND_DIGEST)), biometric-gated. The regenerated leaf's public
 *     key differs from the provision-time key — this is verifier-safe: `key-attestation.ts` binds
 *     anti-relay SOLELY via `KeyDescription.attestationChallenge`, never `leaf.publicKey ==
 *     challenge.deviceKey` (verified by direct source read, see 45-02-PLAN.md).
 *
 * Does NOT compute Digest/sha256 — that is JS-side (45-05). This helper receives already-computed
 * challenge bytes and an already-computed BOUND_DIGEST string (Play Integrity leg lives in
 * [PlayIntegrityHelper]).
 */
class KeyAttestationHelper(private val reactContext: ReactApplicationContext) {

	private val keyStore: KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

	/**
	 * (1) Placeholder-provision (Open Q1): generate the P-256 key ONCE with an empty attestation
	 * challenge and no biometric prompt — Android requires SOME setAttestationChallenge(...) call
	 * to obtain an attestation-carrying cert chain at all, but mere key CREATION does not itself
	 * require a fresh biometric (that gate applies at key USE time in [regenerateAttested]).
	 */
	fun generateProvisionKey(keyAlias: String): ProvisionResult {
		return generateKey(keyAlias, attestationChallenge = null, authenticator = KeyAuthenticator.BIOMETRIC_STRONG)
	}

	/**
	 * Phase 49 (D-16) — provision the second Authority Keystore alias with
	 * [KeyAuthenticator.DEVICE_CREDENTIAL]. Unlike [generateProvisionKey]/[regenerateAttested]'s
	 * two-step placeholder-then-attested dance (Open Q1, a Voter-app/D-11 concern with no analog
	 * here — the Authority app has no attestation flow to bind a challenge to), this key is
	 * generated once, directly, with no attestation challenge at all: it exists purely to sign a
	 * replacement key back into `UserKey` when the primary biometric key is invalidated, not to
	 * produce a verifier-consumed cert chain.
	 */
	fun generateRecoveryKey(keyAlias: String): ProvisionResult {
		return generateKey(keyAlias, attestationChallenge = null, authenticator = KeyAuthenticator.DEVICE_CREDENTIAL)
	}

	/**
	 * (2) Delete + regenerate under [keyAlias] WITH the real attestation challenge bytes
	 * ([attestationChallengeBytes] — utf8(BOUND_DIGEST), already decoded by the caller per
	 * ATTESTATION-CONTRACT.md §3; this helper does NOT re-derive them), then force a fresh
	 * biometric via [BiometricPrompt.authenticate] bound to a [Signature] over the new key (D-06)
	 * before exporting the cert chain. BiometricPrompt is callback-based, not synchronously
	 * returnable — results are delivered via [onResult]/[onKeyInvalidatedReassociate]/[onError].
	 */
	fun regenerateAttested(
		keyAlias: String,
		attestationChallengeBytes: ByteArray,
		activity: FragmentActivity,
		onResult: (List<String>) -> Unit,
		onKeyInvalidatedReassociate: () -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		try {
			keyStore.deleteEntry(keyAlias)
		} catch (e: Exception) {
			// No pre-existing entry (first-ever produceAttestation call after provision) or a
			// benign deletion failure — generateKey below creates a fresh entry regardless.
		}

		try {
			generateKey(keyAlias, attestationChallenge = attestationChallengeBytes)
		} catch (e: NoStrongBoxOrTeeException) {
			onError("NO_STRONGBOX_OR_TEE", e)
			return
		} catch (e: Exception) {
			onError("KEY_ATTESTATION_FAILED", e)
			return
		}

		val signature: Signature
		try {
			val privateKey = keyStore.getKey(keyAlias, null) as PrivateKey
			signature = Signature.getInstance("SHA256withECDSA")
			signature.initSign(privateKey)
		} catch (e: KeyPermanentlyInvalidatedException) {
			// D-13 — the device's biometric enrollment changed since this alias's key was
			// created (new fingerprint/face added, or all biometrics removed). NOT a plain
			// failed-match (that surfaces as onAuthenticationFailed/ERROR_LOCKOUT instead).
			// Delete the invalidated key, regenerate a fresh (non-attested) placeholder so the
			// alias has something to re-provision from, and route the caller into forced
			// re-association — do NOT continue this produceAttestation call.
			try {
				keyStore.deleteEntry(keyAlias)
				generateKey(keyAlias, attestationChallenge = null)
			} catch (cleanupError: Exception) {
				// Best-effort cleanup only — the re-association flow re-provisions regardless of
				// whether this regeneration succeeds.
			}
			onKeyInvalidatedReassociate()
			return
		} catch (e: Exception) {
			onError("KEY_ATTESTATION_FAILED", e)
			return
		}

		val cryptoObject = BiometricPrompt.CryptoObject(signature)
		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle("Confirm your identity")
			.setSubtitle("Verify to produce your device attestation")
			.setNegativeButtonText("Cancel")
			.build()

		// 45-11 DEVICE FINDING — BiometricPrompt's constructor attaches a Fragment to the
		// FragmentActivity's FragmentManager, and `authenticate()` commits it. BOTH must run on
		// the main/UI thread. This helper is invoked from the TurboModule's calling thread (the
		// native-modules thread), so constructing the prompt here threw
		// `Must be called from main thread of fragment host` and no prompt was ever presented.
		// `ContextCompat.getMainExecutor(...)` below only routes the CALLBACKS to main — it does
		// NOT affect the construction or the authenticate() call, which is why this went unnoticed.
		// Jest is structurally blind to this; 45-09 never reached it because the stub producer
		// short-circuited produce() entirely.
		UiThreadUtil.runOnUiThread {
			val biometricPrompt = BiometricPrompt(
				activity,
				ContextCompat.getMainExecutor(reactContext),
				object : BiometricPrompt.AuthenticationCallback() {
				override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
					// A successful prompt IS the cryptographic proof of a fresh biometric check
					// (D-06). For key ATTESTATION (not ballot signing) the cert chain itself does
					// not require an explicit .sign() call here — the biometric gate is enforced
					// by Keystore at key-USE time, which this initSign()+authenticate() ceremony
					// already satisfies.
					try {
						onResult(exportCertificateChain(keyAlias))
					} catch (e: Exception) {
						onError("KEY_ATTESTATION_FAILED", e)
					}
				}

				override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
					// D-09 three-way UX classification (AttestationNativeModule.kt owns the final
					// reject-code contract; this helper surfaces a stable intermediate code per
					// BiometricPrompt errorCode, per 45-RESEARCH.md Pattern 4's error-code table).
					val code = when (errorCode) {
						BiometricPrompt.ERROR_NO_BIOMETRICS -> "NO_BIOMETRICS_ENROLLED"
						BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "LOCKOUT"
						else -> "BIOMETRIC_ERROR"
					}
					onError(code, RuntimeException(errString.toString()))
				}

					override fun onAuthenticationFailed() {
						// Biometric mismatch — a retry, NOT an error. BiometricPrompt itself
						// re-prompts the user; nothing to surface to JS here.
					}
				},
			)
			biometricPrompt.authenticate(promptInfo, cryptoObject)
		}
	}

	/**
	 * (Phase 49, D-06/D-04) Produce a biometric-gated, hardware-backed P-256 signature over
	 * [digestBytes] using the key under [keyAlias]. Follows [regenerateAttested]'s ceremony shape
	 * exactly (resolve key -> catch [KeyPermanentlyInvalidatedException] FIRST -> build
	 * [BiometricPrompt.CryptoObject] -> dispatch on the UI thread -> three-callback
	 * [BiometricPrompt.AuthenticationCallback]), with one addition: unlike [regenerateAttested]
	 * (where the biometric gate alone was the proof — key ATTESTATION needs no signature),
	 * [onAuthenticationSucceeded] here actually signs [digestBytes] and returns the normalized
	 * compact signature — a real signature is the product, not just the biometric check.
	 *
	 * Does NOT recompute [digestBytes] — [AttestationNativeModule] already base64-decoded the
	 * bridge payload (D-04/T-49-DER-2) before calling this.
	 */
	fun signWithDeviceKey(
		keyAlias: String,
		digestBytes: ByteArray,
		activity: FragmentActivity,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		onResult: (String) -> Unit,
		onKeyInvalidatedReassociate: () -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		// 49-UI-SPEC.md's explicitly-flagged sixth condition: no key has EVER been provisioned
		// under this alias — detected BEFORE any prompt is shown, so it must not be collapsed into
		// BIOMETRIC_ERROR (that class implies a prompt was actually presented and failed).
		if (!keyStore.containsAlias(keyAlias)) {
			onError("NO_KEY_PROVISIONED", IllegalStateException("no key provisioned under alias $keyAlias"))
			return
		}

		val signature: Signature
		try {
			val privateKey = keyStore.getKey(keyAlias, null) as PrivateKey
			signature = Signature.getInstance("SHA256withECDSA")
			signature.initSign(privateKey)
		} catch (e: KeyPermanentlyInvalidatedException) {
			// D-13 — caught FIRST, exactly like regenerateAttested — never falls through to the
			// generic catch below. The device's biometric enrollment changed since this alias's key
			// was created; route the caller to restart the D-11 provisioning ceremony.
			onKeyInvalidatedReassociate()
			return
		} catch (e: Exception) {
			onError("BIOMETRIC_ERROR", e)
			return
		}

		val cryptoObject = BiometricPrompt.CryptoObject(signature)
		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle(promptTitle)
			.setSubtitle(promptSubtitle)
			.setNegativeButtonText(promptNegativeButton)
			.build()

		// 45-11 DEVICE FINDING (MUST preserve, T-49-KEY-2): BiometricPrompt construction AND
		// authenticate() both require the main/UI thread. This helper is invoked from the
		// TurboModule's calling thread (the native-modules thread), so both calls stay wrapped here
		// exactly as regenerateAttested wraps them above. Jest is structurally blind to this device-
		// only defect — do not move either call off the UI thread.
		UiThreadUtil.runOnUiThread {
			val biometricPrompt = BiometricPrompt(
				activity,
				ContextCompat.getMainExecutor(reactContext),
				object : BiometricPrompt.AuthenticationCallback() {
					override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
						// D-06/signWithDeviceKey NEW (unlike regenerateAttested, which has no
						// explicit .sign() call): take the CryptoObject's per-use-authenticated
						// Signature, sign the raw digest bytes, and normalize DER -> compact/low-S
						// (D-04) before resolving.
						try {
							val sig = result.cryptoObject!!.signature!!
							sig.update(digestBytes)
							val derSignature = sig.sign()
							val compact = derToCompactLowS(derSignature)
							val hex = compact.joinToString("") { b -> "%02x".format(b) }
							onResult(hex)
						} catch (e: Exception) {
							onError("BIOMETRIC_ERROR", e)
						}
					}

					override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
						// D-13 — cancellation branch FIRST, distinct from the four existing classes;
						// regenerateAttested collapses both lockout codes into LOCKOUT — this mapping
						// deliberately splits them (different remediation copy, 49-UI-SPEC.md). Do
						// NOT retroactively change regenerateAttested's mapping.
						val code = when (errorCode) {
							BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON -> "CANCELED"
							BiometricPrompt.ERROR_NO_BIOMETRICS -> "NO_BIOMETRICS_ENROLLED"
							BiometricPrompt.ERROR_LOCKOUT -> "LOCKOUT"
							BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "LOCKOUT_PERMANENT"
							else -> "BIOMETRIC_ERROR"
						}
						onError(code, RuntimeException(errString.toString()))
					}

					override fun onAuthenticationFailed() {
						// Biometric mismatch — a retry, NOT an error, per D-13 (BiometricPrompt
						// re-prompts itself; nothing to surface to JS here).
					}
				},
			)
			biometricPrompt.authenticate(promptInfo, cryptoObject)
		}
	}

	/**
	 * (Phase 49, D-16/D-26/D-18) Produce a device-credential-authenticated, hardware-backed P-256
	 * signature over [digestBytes] using the recovery key under [keyAlias]. Mirrors
	 * [signWithDeviceKey]'s shape exactly (same [NO_KEY_PROVISIONED]-before-any-prompt check, same
	 * [KeyPermanentlyInvalidatedException]-first catch ordering, same [derToCompactLowS]/
	 * `SHA256withECDSA` [Signature] setup) — ONLY the authentication mechanism branches, by API
	 * level:
	 *
	 * - API 30+ ([signRecoveryViaBiometricPrompt]): [BiometricPrompt] with
	 *   `setAllowedAuthenticators(DEVICE_CREDENTIAL)` and NO negative button — the platform
	 *   forbids setting a negative button together with a device-credential authenticator.
	 * - API 24-29 ([signRecoveryViaKeyguardManager]): [BiometricPrompt] cannot request
	 *   device-credential-only authentication at all below API 30, independent of the Keystore
	 *   key's own flags (D-26, 49-RESEARCH.md "Pitfall 1") — falls back to
	 *   [KeyguardManager.createConfirmDeviceCredentialIntent].
	 *
	 * Before EITHER branch: [KeyguardManager.isDeviceSecure] is checked. A device with no screen
	 * lock at all emits the distinct TERMINAL code `NO_DEVICE_CREDENTIAL` (D-18) rather than
	 * attempting a ceremony that cannot succeed — removing the lock screen destroys this key too
	 * (the device credential IS the lock screen, D-18's boundary), so no retry can fix this state.
	 * A generic `BIOMETRIC_ERROR` here would show the officer a retry affordance for something no
	 * retry can fix.
	 *
	 * **Neither branch has been exercised at runtime by this plan** — the API 30+ branch is proven
	 * by D-24 leg 3 on the Pixel 8 and the API 24-29 branch by D-26a leg 5 on the Redmi 8, both in
	 * 49-14. Compilation is not evidence of either.
	 */
	fun signWithRecoveryKey(
		keyAlias: String,
		digestBytes: ByteArray,
		activity: FragmentActivity,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		onResult: (String) -> Unit,
		onKeyInvalidatedReassociate: () -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		val keyguardManager = ContextCompat.getSystemService(reactContext, KeyguardManager::class.java)
		if (keyguardManager == null || !keyguardManager.isDeviceSecure) {
			// D-18 terminal state, checked BEFORE either ceremony branch begins.
			onError("NO_DEVICE_CREDENTIAL", IllegalStateException("device has no screen lock configured"))
			return
		}

		// Same sixth-condition check as signWithDeviceKey (49-UI-SPEC.md) — the recovery alias may
		// simply never have been provisioned yet.
		if (!keyStore.containsAlias(keyAlias)) {
			onError("NO_KEY_PROVISIONED", IllegalStateException("no recovery key provisioned under alias $keyAlias"))
			return
		}

		val signature: Signature
		try {
			val privateKey = keyStore.getKey(keyAlias, null) as PrivateKey
			signature = Signature.getInstance("SHA256withECDSA")
			signature.initSign(privateKey)
		} catch (e: KeyPermanentlyInvalidatedException) {
			// D-13 — caught FIRST, exactly like signWithDeviceKey. In practice this key's
			// setInvalidatedByBiometricEnrollment flag is a no-op (it governs only biometric-auth
			// keys) so this should not fire from a biometric re-enrolment — but a screen-lock
			// change already routes through the isDeviceSecure() check above, not here, and any
			// OTHER cause of invalidation is still routed identically to signWithDeviceKey.
			onKeyInvalidatedReassociate()
			return
		} catch (e: Exception) {
			onError("BIOMETRIC_ERROR", e)
			return
		}

		if (Build.VERSION.SDK_INT >= 30) {
			signRecoveryViaBiometricPrompt(
				signature = signature,
				digestBytes = digestBytes,
				activity = activity,
				promptTitle = promptTitle,
				promptSubtitle = promptSubtitle,
				onResult = onResult,
				onError = onError,
			)
		} else {
			signRecoveryViaKeyguardManager(
				signature = signature,
				digestBytes = digestBytes,
				activity = activity,
				keyguardManager = keyguardManager,
				promptTitle = promptTitle,
				promptSubtitle = promptSubtitle,
				onResult = onResult,
				onError = onError,
			)
		}
	}

	/** API 30+ branch of [signWithRecoveryKey] — see that function's doc comment for the shape. */
	private fun signRecoveryViaBiometricPrompt(
		signature: Signature,
		digestBytes: ByteArray,
		activity: FragmentActivity,
		promptTitle: String,
		promptSubtitle: String,
		onResult: (String) -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		val cryptoObject = BiometricPrompt.CryptoObject(signature)
		// D-26/49-RESEARCH.md "Pitfall 1" — BiometricPrompt.PromptInfo.Builder THROWS at build()
		// time if setNegativeButtonText is combined with setAllowedAuthenticators(DEVICE_CREDENTIAL)
		// — the platform forbids the combination outright. promptNegativeButton is therefore NOT
		// passed to this builder at all (it is used only by the KeyguardManager branch below).
		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle(promptTitle)
			.setSubtitle(promptSubtitle)
			.setAllowedAuthenticators(BiometricManager.Authenticators.DEVICE_CREDENTIAL)
			.build()

		// 45-11 DEVICE FINDING (MUST preserve, T-49-KEY-2): same UI-thread wrapping as
		// signWithDeviceKey/regenerateAttested — construction AND authenticate() both require it.
		UiThreadUtil.runOnUiThread {
			val biometricPrompt = BiometricPrompt(
				activity,
				ContextCompat.getMainExecutor(reactContext),
				object : BiometricPrompt.AuthenticationCallback() {
					override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
						try {
							val sig = result.cryptoObject!!.signature!!
							sig.update(digestBytes)
							val derSignature = sig.sign()
							val compact = derToCompactLowS(derSignature)
							onResult(compact.joinToString("") { b -> "%02x".format(b) })
						} catch (e: Exception) {
							onError("BIOMETRIC_ERROR", e)
						}
					}

					override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
						// No NO_BIOMETRICS_ENROLLED branch here — that class is meaningless for a
						// DEVICE_CREDENTIAL-only authenticator (it reports absent biometric
						// enrollment, not an absent device credential; NO_DEVICE_CREDENTIAL above
						// already covers the "nothing configured at all" case for this ceremony).
						val code = when (errorCode) {
							BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON -> "CANCELED"
							BiometricPrompt.ERROR_LOCKOUT -> "LOCKOUT"
							BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "LOCKOUT_PERMANENT"
							else -> "BIOMETRIC_ERROR"
						}
						onError(code, RuntimeException(errString.toString()))
					}

					override fun onAuthenticationFailed() {
						// Wrong PIN/pattern/password — a retry, NOT an error; the platform re-prompts
						// itself, nothing to surface to JS here.
					}
				},
			)
			biometricPrompt.authenticate(promptInfo, cryptoObject)
		}
	}

	/**
	 * API 24-29 branch of [signWithRecoveryKey] — see that function's doc comment for the shape.
	 * Launches [KeyguardManager.createConfirmDeviceCredentialIntent] for a result and completes
	 * the ALREADY-INITIALIZED [signature] with the raw digest bytes on success. The
	 * [ActivityEventListener] is scoped to [RECOVERY_KEY_CONFIRM_CREDENTIAL_REQUEST_CODE] and
	 * unregisters itself the instant it fires — the check-then-remove-then-act ordering
	 * (`reactContext.removeActivityEventListener(this)` before any callback is invoked) is what
	 * makes this listener a single-shot despite the ActivityEventListener API itself being
	 * register-once/fire-many, so it cannot leak across configuration changes or double-fire for
	 * one ceremony.
	 */
	private fun signRecoveryViaKeyguardManager(
		signature: Signature,
		digestBytes: ByteArray,
		activity: FragmentActivity,
		keyguardManager: KeyguardManager,
		promptTitle: String,
		promptSubtitle: String,
		onResult: (String) -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		val intent = keyguardManager.createConfirmDeviceCredentialIntent(promptTitle, promptSubtitle)
		if (intent == null) {
			// isDeviceSecure() was already confirmed true by the caller immediately before this —
			// this branch should be unreachable in practice, but is a real (if narrow) TOCTOU
			// window if the device's credential state changes between the two calls.
			onError(
				"NO_DEVICE_CREDENTIAL",
				IllegalStateException("createConfirmDeviceCredentialIntent returned null despite isDeviceSecure() == true"),
			)
			return
		}

		lateinit var listener: ActivityEventListener
		listener = object : ActivityEventListener {
			override fun onActivityResult(act: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
				if (requestCode != RECOVERY_KEY_CONFIRM_CREDENTIAL_REQUEST_CODE) return
				reactContext.removeActivityEventListener(this)
				if (resultCode == Activity.RESULT_OK) {
					try {
						signature.update(digestBytes)
						val derSignature = signature.sign()
						val compact = derToCompactLowS(derSignature)
						onResult(compact.joinToString("") { b -> "%02x".format(b) })
					} catch (e: Exception) {
						onError("BIOMETRIC_ERROR", e)
					}
				} else {
					// Cancelled/dismissed — the same neutral dismissal as the BiometricPrompt
					// branch's CANCELED class, not an error (49-UI-SPEC.md).
					onError("CANCELED", null)
				}
			}

			override fun onNewIntent(intent: Intent) {
				// Not applicable to a startActivityForResult flow — required by the interface only.
			}
		}
		reactContext.addActivityEventListener(listener)
		activity.startActivityForResult(intent, RECOVERY_KEY_CONFIRM_CREDENTIAL_REQUEST_CODE)
	}

	/** (3) D-15b — export leaf+intermediates only; drop the trailing root (verifier pins its own). */
	private fun exportCertificateChain(keyAlias: String): List<String> {
		val chain = keyStore.getCertificateChain(keyAlias)
			?: throw IllegalStateException("no certificate chain for alias $keyAlias")
		return chain.dropLast(1).map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
	}

	/**
	 * Shared keygen core for both the placeholder-provision (1) and attested-regeneration (2)
	 * paths — StrongBox->TEE->(debug-only)stub rungs (D-07). [attestationChallenge] null means
	 * "placeholder" (Open Q1's provision-time call, no real challenge yet); a non-null array is
	 * the real utf8(BOUND_DIGEST) bytes.
	 */
	private fun generateKey(
		keyAlias: String,
		attestationChallenge: ByteArray?,
		authenticator: KeyAuthenticator = KeyAuthenticator.BIOMETRIC_STRONG,
	): ProvisionResult {
		fun buildSpec(strongBox: Boolean): KeyGenParameterSpec {
			val builder = KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_SIGN).apply {
				setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")) // D-03 — P-256 only;
				// secp256k1 is NOT supported for hardware key attestation.
				setDigests(KeyProperties.DIGEST_SHA256)
				setAttestationChallenge(attestationChallenge ?: ByteArray(0))
				setUserAuthenticationRequired(true) // D-17
				// D-17/D-13 — KeyPermanentlyInvalidatedException trigger. Governs ONLY
				// biometric-auth keys (KeyAuthenticator.BIOMETRIC_STRONG) — this is precisely why a
				// KeyAuthenticator.DEVICE_CREDENTIAL key (D-16) SURVIVES a biometric re-enrolment
				// that permanently strands a BIOMETRIC_STRONG key. Setting it unconditionally on
				// BOTH variants reads like a bug otherwise: it is a no-op for DEVICE_CREDENTIAL
				// keys, not a shared invalidation trigger. **D-16 requires this be verified on real
				// hardware, not taken from the docs** — that is D-24 leg 3 in 49-14.
				setInvalidatedByBiometricEnrollment(true)
				if (Build.VERSION.SDK_INT >= 30) {
					val bitmask = when (authenticator) {
						KeyAuthenticator.BIOMETRIC_STRONG -> KeyProperties.AUTH_BIOMETRIC_STRONG
						KeyAuthenticator.DEVICE_CREDENTIAL -> KeyProperties.AUTH_DEVICE_CREDENTIAL
					}
					setUserAuthenticationParameters(0, bitmask) // 0 = per-use (D-06/D-10), both variants
				}
				// else: pre-API-30 fallback (D-26, resolved at planning from RESEARCH Open Question
				// 2). Below API 30 there is no way to request a specific authenticator at the
				// KeyGenParameterSpec/BiometricPrompt API surface — a bare-auth key can still be
				// created via setUserAuthenticationRequired(true) alone (no
				// setUserAuthenticationParameters call, no validity-duration call), but which
				// authenticator satisfies it at USE time is decided by how the key is EXERCISED, not
				// how it was created. For KeyAuthenticator.DEVICE_CREDENTIAL on API 24-29 that means
				// KeyguardManager.createConfirmDeviceCredentialIntent (see signWithRecoveryKey) —
				// BiometricPrompt cannot request device-credential-only authentication at all below
				// API 30, independent of this key's flags. Proven by D-26a leg 5 on the Redmi 8
				// (API 29) in 49-14, not by this comment.
				if (strongBox) {
					setIsStrongBoxBacked(true) // D-07 — try StrongBox first
				}
			}
			return builder.build()
		}

		// StrongBox rung.
		try {
			val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
			generator.initialize(buildSpec(strongBox = true))
			val keyPair = generator.generateKeyPair()
			return ProvisionResult(
				publicKeyBase64 = Base64.encodeToString(keyPair.public.encoded, Base64.NO_WRAP),
				keyAlias = keyAlias,
				securityLevel = "strongbox",
				publicKeyCompressedHex = spkiToCompressedPointHex(keyPair.public.encoded),
			)
		} catch (e: StrongBoxUnavailableException) {
			// Fall through to the TEE rung below.
		}

		// TEE rung.
		try {
			val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
			generator.initialize(buildSpec(strongBox = false))
			val keyPair = generator.generateKeyPair()
			return ProvisionResult(
				publicKeyBase64 = Base64.encodeToString(keyPair.public.encoded, Base64.NO_WRAP),
				keyAlias = keyAlias,
				securityLevel = "tee",
				publicKeyCompressedHex = spkiToCompressedPointHex(keyPair.public.encoded),
			)
		} catch (e: Exception) {
			// Software/stub rung — T-45-04/CR-03: a release build must NEVER reach this rung.
			// __DEV__/BuildConfig.DEBUG is the ONLY gate; anything else rethrows terminal.
			if (BuildConfig.DEBUG) {
				return generateSoftwareStubKey(keyAlias, attestationChallenge, authenticator)
			}
			throw NoStrongBoxOrTeeException(e)
		}
	}

	/**
	 * Debug-only software keygen fallback so the emulator path (no StrongBox/TEE) still runs.
	 * Unreachable in a release build — see the `BuildConfig.DEBUG` guard in [generateKey]. Mirrors
	 * [generateKey]'s [KeyAuthenticator] parameterization so a debug-build recovery key falling to
	 * this rung still gets `AUTH_DEVICE_CREDENTIAL`, not a silently-wrong biometric-only key.
	 */
	private fun generateSoftwareStubKey(
		keyAlias: String,
		attestationChallenge: ByteArray?,
		authenticator: KeyAuthenticator = KeyAuthenticator.BIOMETRIC_STRONG,
	): ProvisionResult {
		val spec = KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_SIGN).apply {
			setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
			setDigests(KeyProperties.DIGEST_SHA256)
			setAttestationChallenge(attestationChallenge ?: ByteArray(0))
			setUserAuthenticationRequired(true)
			setInvalidatedByBiometricEnrollment(true)
			if (Build.VERSION.SDK_INT >= 30) {
				val bitmask = when (authenticator) {
					KeyAuthenticator.BIOMETRIC_STRONG -> KeyProperties.AUTH_BIOMETRIC_STRONG
					KeyAuthenticator.DEVICE_CREDENTIAL -> KeyProperties.AUTH_DEVICE_CREDENTIAL
				}
				setUserAuthenticationParameters(0, bitmask)
			}
		}.build()
		val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
		generator.initialize(spec)
		val keyPair = generator.generateKeyPair()
		return ProvisionResult(
			publicKeyBase64 = Base64.encodeToString(keyPair.public.encoded, Base64.NO_WRAP),
			keyAlias = keyAlias,
			securityLevel = "software",
			publicKeyCompressedHex = spkiToCompressedPointHex(keyPair.public.encoded),
		)
	}
}
