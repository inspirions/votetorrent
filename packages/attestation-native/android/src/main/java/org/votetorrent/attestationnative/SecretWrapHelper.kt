package org.votetorrent.attestationnative

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.security.keystore.UserNotAuthenticatedException
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import java.security.KeyStore
import java.security.ProviderException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

private const val ANDROID_KEYSTORE = "AndroidKeyStore"

/** D-42 generic wrap-key alias pattern — defence in depth beside the JS-side check
 * (`secret-wrap.ts`'s `WRAP_KEY_ALIAS_PATTERN`), so a generic alias can never reach (or collide
 * with) the existing EC signing aliases (`VOTETORRENT_DEVICE_KEY_V1`,
 * `VOTETORRENT_AUTHORITY_SIGNING_KEY_V1`, `VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1`). */
private val WRAP_KEY_ALIAS_PATTERN = Regex("^VOTETORRENT_[A-Z0-9_]+_WRAP_KEY_V[0-9]+$")

/** D-14 upper bound on `authWindowSeconds`. Must equal `MAX_AUTH_WINDOW_SECONDS` in secret-wrap.ts
 * (checked by the Voter's secret-wrap-abi.gate.test.ts). */
internal const val MAX_AUTH_WINDOW_SECONDS = 60

/** D-14 defence in depth beside the JS check: an integer in 0..[MAX_AUTH_WINDOW_SECONDS], and 0
 * unless [requireAuth]. Returns null when [raw] is not acceptable. */
internal fun authWindowSecondsOrNull(raw: Double, requireAuth: Boolean): Int? {
	if (raw.isNaN() || raw.isInfinite() || raw < 0.0 || raw > MAX_AUTH_WINDOW_SECONDS ||
		raw != Math.floor(raw) || (raw > 0.0 && !requireAuth)
	) {
		return null
	}
	return raw.toInt()
}

/**
 * D-14 / A3: the auth window an existing key actually carries, as a number comparable with the
 * requested `authWindowSeconds` (0 = per-use). A key with no user-auth requirement, or with a raw
 * `KeyInfo.userAuthenticationValidityDurationSeconds` of 0 or less, is per-use, so the result is 0.
 * Otherwise the result is the raw value. Android documents -1 for keys that need authentication on
 * every use, and some implementations may report 0 for `setUserAuthenticationParameters(0, ...)`;
 * this rule maps both to per-use, so it is correct whichever way per-use is reported.
 *
 * The authenticator TYPE is deliberately NOT compared: a key created on API < 30 with a validity
 * duration reads back as biometric-or-credential after an OS upgrade to API 30+, and comparing the
 * type would turn an OS upgrade into a permanent policy mismatch (a lost vote record).
 */
internal fun observedAuthWindowSeconds(isUserAuthenticationRequired: Boolean, rawValiditySeconds: Int): Int {
	if (!isUserAuthenticationRequired || rawValiditySeconds <= 0) return 0
	return rawValiditySeconds
}

/** D-14 A3 read-back: logs the RAW `KeyInfo` validity value on every existing-alias check. */
private const val TAG_WRAP_KEY_POLICY = "VtWrapKeyPolicy"

/** D-14 windowed-path observability: closed `path` tokens only (no-prompt, prompted,
 * reinit-unauthenticated). */
private const val TAG_WRAP_WINDOW = "VtWrapWindow"

/** D-07-style rung observability for the wrap-key StrongBox->TEE ladder, distinct from
 * [KeyAttestationHelper]'s `VtKeygenRung` tag (different keys, same reasoning). */
private const val TAG_WRAP_KEY_RUNG = "VtWrapKeyRung"

/** Typed exception mapping to the `INVALID_ARGUMENT` reject code (invalid alias). */
class InvalidWrapKeyAliasException(alias: String) : Exception("invalid wrap key alias: $alias")

/** Typed exception mapping to `WRAP_KEY_POLICY_MISMATCH` — an existing alias's stored
 * auth policy (requireAuth and window, or key type) does not match the caller's `requireAuth` request. Never silently
 * downgraded/upgraded (T-62-08-11). */
class WrapKeyPolicyMismatchException(message: String) : Exception(message)

/** Typed exception mapping to `NO_WRAP_KEY` — no key exists under the requested alias. */
class NoWrapKeyException(alias: String) : Exception("no wrap key under alias $alias")

/**
 * SecretWrapHelper — D-42 (Phase 62 plan 08): AndroidKeyStore AES-256-GCM get-or-create +
 * wrap/unwrap, with an optional BiometricPrompt/CryptoObject path when `requireAuth` is true.
 * Generic across every `VOTETORRENT_*_WRAP_KEY_V<n>` alias — this is NOT the P-256 signing-key
 * flow [KeyAttestationHelper] owns.
 *
 * **CRITICAL — never regenerate, never delete.** Unlike [KeyAttestationHelper.regenerateAttested]
 * (which deliberately deletes and regenerates its alias on every call — D-13 key non-reuse, the
 * right design for an attested SIGNING key), a wrap key protects the ONLY copy of a secret
 * (D-42/D-40's enrollment identity key is the first consumer). Deleting or regenerating it would
 * make every ciphertext wrapped under it permanently unreadable. This class contains no
 * `deleteEntry` call anywhere, and [getOrCreateKey] NEVER regenerates an alias that already
 * exists — it returns the existing key, or rejects `WRAP_KEY_POLICY_MISMATCH` if the existing
 * key's auth policy does not match the request.
 *
 * **D-14 (Phase 63) time-bound mode.** `authWindowSeconds > 0` is legal only with `requireAuth`;
 * its only caller is the vote-record alias, with R-5's 10 s window. The key is created time-bound:
 * `setUserAuthenticationParameters(n, AUTH_BIOMETRIC_STRONG)` on API >= 30 and
 * `setUserAuthenticationValidityDurationSeconds(n)` on API < 30. On API < 30 that also admits a
 * device credential (assumption A2, unproven; the device proof covers one API-37 AVD). Use is
 * try-init-first: `Cipher.init` runs with no prompt, and on `UserNotAuthenticatedException` there
 * is exactly ONE BIOMETRIC_STRONG prompt WITHOUT a CryptoObject, then exactly one re-init. Per-use
 * keys need a CryptoObject; time-bound keys accept a recent authentication (the D-26 precedent).
 * Do not mix the two. The residual: inside the window, any code in this app's process can use the
 * key; this is D-14's accepted trade. Windows remain forbidden for the P-256 signing and recovery
 * keys (KeyAttestationHelper D-10/D-26a); this mode exists only for wrap aliases. One alias = one
 * policy (requireAuth AND window), enforced through [observedAuthWindowSeconds].
 */
class SecretWrapHelper(private val reactContext: ReactApplicationContext) {

	private val keyStore: KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

	/** Get-or-create the AES-256-GCM wrap key under [alias]. Serialized so a concurrent
	 * create/create race can never generate two keys under the same alias (T-62-08-03). */
	@Synchronized
	fun getOrCreateKey(alias: String, requireAuth: Boolean, authWindowSeconds: Int): Pair<SecretKey, String> {
		if (!WRAP_KEY_ALIAS_PATTERN.matches(alias)) {
			throw InvalidWrapKeyAliasException(alias)
		}

		if (keyStore.containsAlias(alias)) {
			val entry = keyStore.getEntry(alias, null)
			if (entry !is KeyStore.SecretKeyEntry) {
				throw WrapKeyPolicyMismatchException("alias $alias does not hold a SecretKeyEntry (wrong key type)")
			}
			val secretKey = entry.secretKey
			val keyInfo = SecretKeyFactory.getInstance(secretKey.algorithm, ANDROID_KEYSTORE)
				.getKeySpec(secretKey, KeyInfo::class.java) as KeyInfo
			if (keyInfo.isUserAuthenticationRequired != requireAuth) {
				// Never a silent downgrade/upgrade (T-62-08-11) — a policy mismatch on an
				// existing alias must be rejected, not reconciled.
				throw WrapKeyPolicyMismatchException(
					"alias $alias was created with requireAuth=${keyInfo.isUserAuthenticationRequired}, " +
						"but this call requested requireAuth=$requireAuth",
				)
			}
			val raw = keyInfo.userAuthenticationValidityDurationSeconds
			val observed = observedAuthWindowSeconds(keyInfo.isUserAuthenticationRequired, raw)
			Log.i(TAG_WRAP_KEY_POLICY, "alias=$alias requireAuth=${keyInfo.isUserAuthenticationRequired} rawValiditySeconds=$raw observedWindow=$observed requestedWindow=$authWindowSeconds")
			if (observed != authWindowSeconds) {
				throw WrapKeyPolicyMismatchException(
					"alias $alias was created with authWindowSeconds=$observed, " +
						"but this call requested authWindowSeconds=$authWindowSeconds",
				)
			}
			return secretKey to resolveSecurityLevel(keyInfo)
		}

		return generateKey(alias, requireAuth, authWindowSeconds)
	}

	private fun buildSpec(alias: String, requireAuth: Boolean, authWindowSeconds: Int, strongBox: Boolean): KeyGenParameterSpec {
		val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
			.setBlockModes(KeyProperties.BLOCK_MODE_GCM)
			.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
			.setKeySize(256)
			.setRandomizedEncryptionRequired(true)
			// D-42/Pitfall 2: the identity alias passes requireAuth=false — protection here is
			// against EXTRACTION (a rooted device / backup / stolen RKStorage file), not against
			// use by whoever already holds the unlocked device. A
			// requireAuth=false alias never gets any auth setting; a validity duration is used ONLY
			// by the D-14 windowed branch below API 30 (see the class comment).
			.setUserAuthenticationRequired(requireAuth)
		if (requireAuth) {
			// Only the auth-required branch (e.g. 62-26's keyholder-share alias) sets these —
			// the D-42 identity alias (requireAuth=false) never does.
			builder.setInvalidatedByBiometricEnrollment(true)
			if (authWindowSeconds > 0) {
				// D-14: time-bound key, applied on every API level so a device upgraded across
				// API 30 keeps its policy.
				if (Build.VERSION.SDK_INT >= 30) {
					builder.setUserAuthenticationParameters(authWindowSeconds, KeyProperties.AUTH_BIOMETRIC_STRONG)
				} else {
					@Suppress("DEPRECATION")
					builder.setUserAuthenticationValidityDurationSeconds(authWindowSeconds)
				}
			} else if (Build.VERSION.SDK_INT >= 30) {
				builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG) // 0 = per-use
			}
		}
		if (strongBox) {
			builder.setIsStrongBoxBacked(true)
		}
		return builder.build()
	}

	/** StrongBox->TEE rung ladder (D-07 class), no debug software-stub rung — a keygen failure on
	 * either rung is WRAP_FAILED. */
	private fun generateKey(alias: String, requireAuth: Boolean, authWindowSeconds: Int): Pair<SecretKey, String> {
		try {
			val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
			generator.init(buildSpec(alias, requireAuth, authWindowSeconds, strongBox = true))
			val key = generator.generateKey()
			Log.i(TAG_WRAP_KEY_RUNG, "StrongBox rung selected for alias=$alias")
			return key to "strongbox"
		} catch (e: StrongBoxUnavailableException) {
			Log.i(TAG_WRAP_KEY_RUNG, "StrongBox unavailable for alias=$alias — stepping down to TEE")
		} catch (e: ProviderException) {
			// Mirrors KeyAttestationHelper.generateKey's identical reasoning: a StrongBox chip IS
			// present but rejected this request — step down to TEE rather than fail outright.
			// This is a rung DOWNGRADE, not an absent chip.
			Log.w(TAG_WRAP_KEY_RUNG, "StrongBox present but REJECTED alias=$alias — stepping down to TEE (downgrade, not absent chip)", e)
		}

		val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
		generator.init(buildSpec(alias, requireAuth, authWindowSeconds, strongBox = false))
		val key = generator.generateKey()
		return key to "tee"
	}

	private fun resolveSecurityLevel(keyInfo: KeyInfo): String {
		if (Build.VERSION.SDK_INT >= 31) {
			return when (keyInfo.securityLevel) {
				KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
				KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
				KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
				else -> "unknown"
			}
		}
		return if (keyInfo.isInsideSecureHardware) "tee" else "software"
	}

	/** Wrap [plaintext] under [alias]'s key. Native generates a fresh 12-byte IV (no caller IV). */
	fun wrap(
		alias: String,
		plaintext: ByteArray,
		aad: ByteArray,
		requireAuth: Boolean,
		activity: FragmentActivity?,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		authWindowSeconds: Int,
		onResult: (ciphertext: ByteArray, iv: ByteArray, securityLevel: String) -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		// D-14 window bounds (63-17): defence in depth beside the JS validation and
		// authWindowSecondsOrNull. Runs before any getOrCreateKey, so no alias is ever created under a
		// policy the caller did not validly ask for.
		if (authWindowSeconds < 0 || authWindowSeconds > MAX_AUTH_WINDOW_SECONDS || (authWindowSeconds > 0 && !requireAuth)) {
			onError("INVALID_ARGUMENT", IllegalArgumentException("authWindowSeconds out of bounds"))
			return
		}
		val (key, securityLevel) = try {
			getOrCreateKey(alias, requireAuth, authWindowSeconds)
		} catch (e: InvalidWrapKeyAliasException) {
			onError("INVALID_ARGUMENT", e); return
		} catch (e: WrapKeyPolicyMismatchException) {
			onError("WRAP_KEY_POLICY_MISMATCH", e); return
		} catch (e: Exception) {
			onError("WRAP_FAILED", e); return
		}

		if (requireAuth && authWindowSeconds > 0) {
			wrapWindowed(alias, key, securityLevel, plaintext, aad, activity, promptTitle, promptSubtitle, promptNegativeButton, onResult, onError)
			return
		}

		val cipher: Cipher
		try {
			cipher = Cipher.getInstance("AES/GCM/NoPadding")
			cipher.init(Cipher.ENCRYPT_MODE, key)
		} catch (e: Exception) {
			onError("WRAP_FAILED", e); return
		}

		fun doWrap(c: Cipher) {
			try {
				c.updateAAD(aad)
				val ciphertext = c.doFinal(plaintext)
				val iv = c.iv
				if (iv.size != 12) {
					onError("WRAP_FAILED", IllegalStateException("unexpected IV length ${iv.size}")); return
				}
				onResult(ciphertext, iv, securityLevel)
			} catch (e: Exception) {
				onError("WRAP_FAILED", e)
			}
		}

		if (!requireAuth) {
			doWrap(cipher)
			return
		}

		if (activity == null) {
			onError("NO_ACTIVITY", IllegalStateException("no current FragmentActivity available to host the BiometricPrompt"))
			return
		}

		val cryptoObject = BiometricPrompt.CryptoObject(cipher)
		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle(promptTitle)
			.setSubtitle(promptSubtitle)
			.setNegativeButtonText(promptNegativeButton)
			.build()

		UiThreadUtil.runOnUiThread {
			val biometricPrompt = BiometricPrompt(
				activity,
				ContextCompat.getMainExecutor(reactContext),
				object : BiometricPrompt.AuthenticationCallback() {
					override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
						doWrap(result.cryptoObject!!.cipher!!)
					}

					override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
						onError(mapBiometricErrorCode(errorCode), RuntimeException(errString.toString()))
					}

					override fun onAuthenticationFailed() {
						// Biometric mismatch — a retry, not an error (BiometricPrompt re-prompts itself).
					}
				},
			)
			biometricPrompt.authenticate(promptInfo, cryptoObject)
		}
	}

	/** Unwrap a previously-wrapped secret under [alias]. */
	fun unwrap(
		alias: String,
		ciphertext: ByteArray,
		iv: ByteArray,
		aad: ByteArray,
		requireAuth: Boolean,
		activity: FragmentActivity?,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		authWindowSeconds: Int,
		onResult: (plaintext: ByteArray) -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		// D-14 window bounds (63-17): defence in depth beside the JS validation and
		// authWindowSecondsOrNull. Runs before any getOrCreateKey, so no alias is ever created under a
		// policy the caller did not validly ask for.
		if (authWindowSeconds < 0 || authWindowSeconds > MAX_AUTH_WINDOW_SECONDS || (authWindowSeconds > 0 && !requireAuth)) {
			onError("INVALID_ARGUMENT", IllegalArgumentException("authWindowSeconds out of bounds"))
			return
		}
		if (!WRAP_KEY_ALIAS_PATTERN.matches(alias)) {
			onError("INVALID_ARGUMENT", InvalidWrapKeyAliasException(alias)); return
		}
		if (!keyStore.containsAlias(alias)) {
			// Decided BEFORE any prompt — a backup-restored device with ciphertext but no key
			// fails closed here (T-62-08-10), never regenerating or overwriting anything.
			onError("NO_WRAP_KEY", NoWrapKeyException(alias)); return
		}
		if (iv.size != 12) {
			onError("INVALID_ENCODING", IllegalArgumentException("iv must be 12 bytes, got ${iv.size}")); return
		}

		val (key, _) = try {
			getOrCreateKey(alias, requireAuth, authWindowSeconds)
		} catch (e: WrapKeyPolicyMismatchException) {
			onError("WRAP_KEY_POLICY_MISMATCH", e); return
		} catch (e: Exception) {
			onError("UNWRAP_FAILED", e); return
		}

		if (requireAuth && authWindowSeconds > 0) {
			unwrapWindowed(alias, key, ciphertext, iv, aad, activity, promptTitle, promptSubtitle, promptNegativeButton, onResult, onError)
			return
		}

		val cipher: Cipher
		try {
			cipher = Cipher.getInstance("AES/GCM/NoPadding")
			cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
		} catch (e: KeyPermanentlyInvalidatedException) {
			onError("KEY_INVALIDATED", e); return
		} catch (e: Exception) {
			onError("UNWRAP_FAILED", e); return
		}

		fun doUnwrap(c: Cipher) {
			try {
				c.updateAAD(aad)
				val plaintext = c.doFinal(ciphertext)
				onResult(plaintext)
			} catch (e: KeyPermanentlyInvalidatedException) {
				onError("KEY_INVALIDATED", e)
			} catch (e: AEADBadTagException) {
				onError("UNWRAP_TAG_MISMATCH", e)
			} catch (e: Exception) {
				onError("UNWRAP_FAILED", e)
			}
		}

		if (!requireAuth) {
			doUnwrap(cipher)
			return
		}

		if (activity == null) {
			onError("NO_ACTIVITY", IllegalStateException("no current FragmentActivity available to host the BiometricPrompt"))
			return
		}

		val cryptoObject = BiometricPrompt.CryptoObject(cipher)
		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle(promptTitle)
			.setSubtitle(promptSubtitle)
			.setNegativeButtonText(promptNegativeButton)
			.build()

		UiThreadUtil.runOnUiThread {
			val biometricPrompt = BiometricPrompt(
				activity,
				ContextCompat.getMainExecutor(reactContext),
				object : BiometricPrompt.AuthenticationCallback() {
					override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
						doUnwrap(result.cryptoObject!!.cipher!!)
					}

					override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
						onError(mapBiometricErrorCode(errorCode), RuntimeException(errString.toString()))
					}

					override fun onAuthenticationFailed() {
						// Biometric mismatch — a retry, not an error.
					}
				},
			)
			biometricPrompt.authenticate(promptInfo, cryptoObject)
		}
	}

	/**
	 * D-14 time-bound wrap: try `Cipher.init` with NO prompt first (a biometric authentication inside
	 * the window, e.g. the vote-signing prompt, already authorises the key). On
	 * [UserNotAuthenticatedException] show exactly ONE BIOMETRIC_STRONG prompt with NO CryptoObject,
	 * then re-init exactly once. Never loops. Logs carry only the alias, op and a closed path token.
	 */
	private fun wrapWindowed(
		alias: String,
		key: SecretKey,
		securityLevel: String,
		plaintext: ByteArray,
		aad: ByteArray,
		activity: FragmentActivity?,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		onResult: (ciphertext: ByteArray, iv: ByteArray, securityLevel: String) -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		fun initCipher(): Cipher {
			val c = Cipher.getInstance("AES/GCM/NoPadding")
			c.init(Cipher.ENCRYPT_MODE, key)
			return c
		}

		fun finish(c: Cipher) {
			try {
				c.updateAAD(aad)
				val ciphertext = c.doFinal(plaintext)
				val iv = c.iv
				if (iv.size != 12) {
					onError("WRAP_FAILED", IllegalStateException("unexpected IV length ${iv.size}")); return
				}
				onResult(ciphertext, iv, securityLevel)
			} catch (e: Exception) {
				onError("WRAP_FAILED", e)
			}
		}

		try {
			val c = initCipher()
			Log.i(TAG_WRAP_WINDOW, "alias=$alias op=wrap path=no-prompt")
			finish(c)
			return
		} catch (e: KeyPermanentlyInvalidatedException) {
			onError("KEY_INVALIDATED", e); return
		} catch (e: UserNotAuthenticatedException) {
			// Fall through to the single prompt below.
		} catch (e: Exception) {
			onError("WRAP_FAILED", e); return
		}

		if (activity == null) {
			onError("NO_ACTIVITY", IllegalStateException("no current FragmentActivity available to host the BiometricPrompt"))
			return
		}

		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle(promptTitle)
			.setSubtitle(promptSubtitle)
			.setNegativeButtonText(promptNegativeButton)
			.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
			.build()

		UiThreadUtil.runOnUiThread {
			val biometricPrompt = BiometricPrompt(
				activity,
				ContextCompat.getMainExecutor(reactContext),
				object : BiometricPrompt.AuthenticationCallback() {
					override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
						Log.i(TAG_WRAP_WINDOW, "alias=$alias op=wrap path=prompted")
						try {
							finish(initCipher())
						} catch (e: KeyPermanentlyInvalidatedException) {
							onError("KEY_INVALIDATED", e)
						} catch (e: UserNotAuthenticatedException) {
							Log.w(TAG_WRAP_WINDOW, "alias=$alias op=wrap path=reinit-unauthenticated")
							onError("WRAP_FAILED", e)
						} catch (e: Exception) {
							onError("WRAP_FAILED", e)
						}
					}

					override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
						onError(mapBiometricErrorCode(errorCode), RuntimeException(errString.toString()))
					}

					override fun onAuthenticationFailed() {
						// Biometric mismatch — a retry, not an error (BiometricPrompt re-prompts itself).
					}
				},
			)
			biometricPrompt.authenticate(promptInfo)
		}
	}

	/** D-14 time-bound unwrap: mirrors [wrapWindowed] (try-init, one CryptoObject-free prompt, one re-init). */
	private fun unwrapWindowed(
		alias: String,
		key: SecretKey,
		ciphertext: ByteArray,
		iv: ByteArray,
		aad: ByteArray,
		activity: FragmentActivity?,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		onResult: (plaintext: ByteArray) -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		fun initCipher(): Cipher {
			val c = Cipher.getInstance("AES/GCM/NoPadding")
			c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
			return c
		}

		fun finish(c: Cipher) {
			try {
				c.updateAAD(aad)
				val plaintext = c.doFinal(ciphertext)
				onResult(plaintext)
			} catch (e: KeyPermanentlyInvalidatedException) {
				onError("KEY_INVALIDATED", e)
			} catch (e: AEADBadTagException) {
				onError("UNWRAP_TAG_MISMATCH", e)
			} catch (e: Exception) {
				onError("UNWRAP_FAILED", e)
			}
		}

		try {
			val c = initCipher()
			Log.i(TAG_WRAP_WINDOW, "alias=$alias op=unwrap path=no-prompt")
			finish(c)
			return
		} catch (e: KeyPermanentlyInvalidatedException) {
			onError("KEY_INVALIDATED", e); return
		} catch (e: UserNotAuthenticatedException) {
			// Fall through to the single prompt below.
		} catch (e: Exception) {
			onError("UNWRAP_FAILED", e); return
		}

		if (activity == null) {
			onError("NO_ACTIVITY", IllegalStateException("no current FragmentActivity available to host the BiometricPrompt"))
			return
		}

		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle(promptTitle)
			.setSubtitle(promptSubtitle)
			.setNegativeButtonText(promptNegativeButton)
			.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
			.build()

		UiThreadUtil.runOnUiThread {
			val biometricPrompt = BiometricPrompt(
				activity,
				ContextCompat.getMainExecutor(reactContext),
				object : BiometricPrompt.AuthenticationCallback() {
					override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
						Log.i(TAG_WRAP_WINDOW, "alias=$alias op=unwrap path=prompted")
						try {
							finish(initCipher())
						} catch (e: KeyPermanentlyInvalidatedException) {
							onError("KEY_INVALIDATED", e)
						} catch (e: UserNotAuthenticatedException) {
							Log.w(TAG_WRAP_WINDOW, "alias=$alias op=unwrap path=reinit-unauthenticated")
							onError("UNWRAP_FAILED", e)
						} catch (e: Exception) {
							onError("UNWRAP_FAILED", e)
						}
					}

					override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
						onError(mapBiometricErrorCode(errorCode), RuntimeException(errString.toString()))
					}

					override fun onAuthenticationFailed() {
						// Biometric mismatch — a retry, not an error.
					}
				},
			)
			biometricPrompt.authenticate(promptInfo)
		}
	}

	/** Reuses [KeyAttestationHelper.signWithDeviceKey]'s errorCode -> code mapping verbatim
	 * (CANCELED/NO_BIOMETRICS_ENROLLED/LOCKOUT/LOCKOUT_PERMANENT/BIOMETRIC_ERROR). */
	private fun mapBiometricErrorCode(errorCode: Int): String = when (errorCode) {
		BiometricPrompt.ERROR_CANCELED,
		BiometricPrompt.ERROR_USER_CANCELED,
		BiometricPrompt.ERROR_NEGATIVE_BUTTON -> "CANCELED"
		BiometricPrompt.ERROR_NO_BIOMETRICS -> "NO_BIOMETRICS_ENROLLED"
		BiometricPrompt.ERROR_LOCKOUT -> "LOCKOUT"
		BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "LOCKOUT_PERMANENT"
		else -> "BIOMETRIC_ERROR"
	}
}
